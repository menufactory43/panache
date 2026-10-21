// first: the Belle Époque switch tags <html> before the menu draws (src/ui/belle.css)
import { BELLE_EPOQUE } from "./game/three/theme";
import { DIFFICULTY, type Difficulty } from "./sim/ai/commander";
import { MAPS, isKnownMapId, mapById } from "./sim/maps";
import { BIOMES, RANDOM_MAP_SIZE, RANDOM_PREFIX, isRandomMapId, parseRandomMapId, randomMapId, rollRandomMapId, seedCode, seedFromText } from "./sim/mapgen";
import type { Biome } from "./sim/types";
import { sfx } from "./game/audio";
import { music } from "./game/music";
import { loadTerrainArt, mapThumbUrl } from "./game/assets";
import { GameScene, type MatchFeed } from "./game/GameScene";
import { setLocalSide } from "./game/controller";
import { activeMutators, duelSetup, gameMode, loadSettings, saveSettings, unchartedMatch, type GameType } from "./game/mode";
import { loadBest } from "./game/survival";
import { HELP_HTML } from "./ui/hud";
import { mountMenuCareer, openSheet, starsText } from "./ui/career";
import { dailyOp, today, type DailyOp } from "./game/daily";
import { TUTORIAL_OP, opById, type OpDef } from "./sim/ops";
import { setTutorialState, tutorialState } from "./game/tutorial";
import { showTutorialPrompt } from "./ui/tutorial";
import { loadCareer } from "./game/career";
import type { MutatorId } from "./sim/rules";
import { mountMenuOps } from "./ui/ops";
import { fullscreen, resetAudioSession } from "./ui/fullscreen";
import { appUpdate, mountUpdatePill } from "./ui/update";
import { scrollCue } from "./ui/hscroll";
import { showReplayPicker } from "./ui/replay-picker";
import { openMapPreview } from "./ui/map-preview";
import { mountTitle } from "./ui/title";
// (types only: the sound duel's code is a lazily loaded chunk, reached through loadDuel() alone)
import type * as DuelLobby from "./versus/lobby";
import type { VersusFeed } from "./versus/feed";

document.addEventListener("contextmenu", (e) => e.preventDefault());

// iOS Safari ignores user-scalable=no: pinch zooms the PAGE (scaling the
// HUD with it) and offers no way back. Kill browser zoom at the source —
// the game camera handles all zooming.
for (const type of ["gesturestart", "gesturechange", "gestureend"])
  document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
document.addEventListener(
  "touchmove",
  (e) => {
    // (only iOS has a pinch scale; elsewhere it's undefined, and an uncancelable
    // move — a scroll already under way — just logs an intervention)
    const scale = (e as TouchEvent & { scale?: number }).scale;
    if (e.cancelable && typeof scale === "number" && scale !== 1) e.preventDefault();
  },
  { passive: false }
);
document.addEventListener("dblclick", (e) => e.preventDefault(), { passive: false });

// Safety net: if browser page-zoom happens anyway (iOS finds ways), show a
// rescue button pinned inside the VISUAL viewport (fixed-position elements
// live in the layout viewport and can be off-screen while zoomed).
function setupPageZoomRescue(): void {
  const vv = window.visualViewport;
  if (!vv) return;
  const btn = document.createElement("button");
  btn.id = "unzoom";
  btn.textContent = "⤺ Dézoomer";
  btn.hidden = true;
  document.body.appendChild(btn);

  const place = () => {
    const zoomed = vv.scale > 1.05;
    btn.hidden = !zoomed;
    if (!zoomed) return;
    const s = 1 / vv.scale;
    btn.style.left = `${vv.offsetLeft}px`;
    btn.style.top = `${vv.offsetTop + vv.height - 56 * s}px`;
    btn.style.width = `${vv.width}px`;
    btn.style.height = `${56 * s}px`;
    btn.style.fontSize = `${17 * s}px`;
  };
  vv.addEventListener("resize", place);
  vv.addEventListener("scroll", place);
  place();

  btn.addEventListener("click", () => {
    // rewriting the viewport meta forces Safari to re-clamp scale to 1
    const meta = document.querySelector<HTMLMetaElement>("meta[name=viewport]");
    if (!meta) return;
    const content = meta.content;
    meta.content = "width=device-width, initial-scale=1.0, maximum-scale=1.0";
    requestAnimationFrame(() => {
      meta.content = content;
      place();
    });
  });
}
setupPageZoomRescue();
// iOS's audio session back to "auto" before any audio context exists, on every boot: a sound duel's page that
// went without letting it go (its rig sets play-and-record) left it so for this one, as Safari keeps the type
// in the tab while this page reads "auto" (ui/fullscreen.ts resetAudioSession). A context made under it can
// take a low rate (src/link/rig.ts "The rate"); the rig sets play-and-record again only after making its own.
resetAudioSession();
// a rematch or Menu reload dropped full screen: ask again on the first tap
fullscreen.restoreOnGesture();
// a new build: the menu offers to reload into it (ui/update.ts)
appUpdate.watch();

/**
 * The sound duel (SOUND-DUEL.md "Getting into a duel"): its lobby and
 * everything under it come in one lazily loaded chunk, fetched once the menu
 * shows on a phone that can run it (a secure context with AudioWorklet and a
 * microphone), or in every build with ?duel=loop / ?duel=relay (no sound).
 */
let duelLoad: Promise<typeof DuelLobby> | null = null;
const loadDuel = (): Promise<typeof DuelLobby> => (duelLoad ??= import("./versus/lobby"));
const duelPractice = ["loop", "relay"].includes(new URLSearchParams(location.search).get("duel") ?? "");
const canDuel = (): boolean =>
  duelPractice || (window.isSecureContext && typeof AudioWorkletNode === "function" && typeof navigator.mediaDevices?.getUserMedia === "function");
/** The online duel (src/versus/online.ts, same chunk): a WebSocket to the relay is all it needs. */
const canDuelOnline = (): boolean => typeof WebSocket === "function";
/** An invite link's room code (`?salon=ABCD`): the menu opens the online duel's lobby on it (the URL loses it at boot). */
const salonLink = new URLSearchParams(location.search).get("salon");
const DUEL_UPDATE = "Une nouvelle version est prête : recharge ce téléphone (et celui de ton ami)";
/**
 * sessionStorage: what the next boot skips into (the end screen's Rematch: "1", "spectate", "daily", "op:<id>",
 * or a sound duel's "duel"). The duel's records.ts owns the key and the duel's token; main.ts may import the
 * duel's types only, so these literals are tied to them by type (and tests/versus-rematch.test.ts reads them).
 */
const REMATCH_KEY: typeof DuelLobby.REMATCH_KEY = "battledrones.rematch";
const DUEL_REMATCH: typeof DuelLobby.REMATCH_DUEL = "duel";
const DUEL_KEY: typeof DuelLobby.DUEL_KEY = "battledrones.duel";
/** The stored rematch is an online duel's (its plan names a room): no sound, so no link mode at boot. */
const rematchIsOnline = (): boolean => {
  try {
    return /"online"\s*:\s*\{/.test(sessionStorage.getItem(DUEL_KEY) ?? "");
  } catch {
    return false;
  }
};

/** Render at device resolution (capped at 2× for phone GPUs) for crisp art. */
const dpr = () => Math.min(2, Math.max(1, window.devicePixelRatio || 1));

async function startGame(feed?: MatchFeed): Promise<void> {
  const hud = document.getElementById("hud")!;
  const loading = document.createElement("div");
  loading.id = "loading";
  loading.className = "screen";
  const def = mapById(gameMode.mapId);
  // (Uncharted: not even the name gives the map away)
  const where = unchartedMatch() ? "territoire inconnu" : def.id === gameMode.mapId ? def.name : "champ de bataille";
  loading.innerHTML = `<div class="loadbox"><p>Déploiement : ${where}…</p><div class="loadtrack"><div id="loadbar"></div></div></div>`;
  hud.appendChild(loading);
  const bar = loading.querySelector<HTMLElement>("#loadbar");
  // the painted terrain is draped over the 3D landscape; a failed chunk falls back to flat colours
  const art = await loadTerrainArt(def.id, def.size, def.biome, (k) => {
    if (bar) bar.style.width = `${Math.round(k * 90)}%`;
  });
  if (bar) bar.style.width = "100%";
  // (let the full bar paint before the scene build blocks the main thread)
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  // /?side=red, in every build: a skirmish played as red against a blue AI, the side a sound duel's
  // other phone plays (SOUND-DUEL.md "Playing red"). Not Last Stand, an op or the Daily Op, which
  // are set up for blue, nor a watched match; a fed match (a replay, a duel) brings its own side.
  // (before the scene: its presenters copy the side as they are built)
  const asRed = new URLSearchParams(location.search).get("side") === "red";
  if (asRed && !feed && gameMode.mode === "skirmish" && !gameMode.spectator && !gameMode.daily && !gameMode.op) setLocalSide("red");
  const scene = new GameScene(document.getElementById("game")!, dpr(), art, feed);
  window.addEventListener("resize", () => scene.resize());
  window.addEventListener("orientationchange", () => setTimeout(() => scene.resize(), 200));
}

// ------------------------------------------------------------ random maps ---

const BIOME_ICON: Record<Biome, string> = { temperate: "🌳", desert: "🏜️", arctic: "❄️", volcanic: "🌋", tropical: "🌴" };
/** Biome names as the player reads them. */
const BIOME_FR: Record<Biome, string> = { temperate: "tempéré", desert: "désert", arctic: "arctique", volcanic: "volcanique", tropical: "tropical" };
const RANDOM_KEY = "battledrones.randommaps";
/** A transparent pixel: the Uncharted card keeps its image box (the fog sits on it) with nothing of the map in it. */
const BLANK_IMG = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const RECENT_MAX = 6;

/** The menu's random-map picks: the biome rerolls keep to (null: any) and the last few maps seen, newest first. */
interface RandomPrefs {
  biome: Biome | null;
  recent: { id: string; name: string }[];
}

function loadRandomPrefs(): RandomPrefs {
  const prefs: RandomPrefs = { biome: null, recent: [] };
  try {
    const s = JSON.parse(localStorage.getItem(RANDOM_KEY) ?? "{}") as Partial<RandomPrefs>;
    if (BIOMES.includes(s.biome as Biome)) prefs.biome = s.biome!;
    // (names are kept so the chips don't regrow six maps on every menu visit)
    if (Array.isArray(s.recent))
      prefs.recent = s.recent
        .filter((r) => typeof r?.id === "string" && typeof r.name === "string" && parseRandomMapId(r.id) !== null)
        .slice(0, RECENT_MAX);
  } catch {
    /* storage unavailable — start fresh */
  }
  return prefs;
}

function saveRandomPrefs(prefs: RandomPrefs): void {
  try {
    localStorage.setItem(RANDOM_KEY, JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
}

/** A shareable link to this game with a map preselected (?map=<id>, read on boot). */
function mapLink(id: string): string {
  const url = new URL(location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("map", id);
  return url.toString();
}

/**
 * What a player typed into the seed box: a whole random map id (or a pasted
 * link holding one) picks that map; a code of any length is taken as is (the
 * longest 32-bit codes are 7 characters); other text is hashed into a seed.
 */
function idFromSeedText(text: string, biome: Biome): string {
  const t = text.trim().toLowerCase();
  const whole = /random-[a-z]+-[0-9a-z]+/.exec(t)?.[0];
  if (whole && parseRandomMapId(whole)) return whole;
  const code = t.replace(/^#/, "");
  const exact = parseRandomMapId(`${RANDOM_PREFIX}${biome}-${code}`);
  return randomMapId(biome, exact ? exact.seed : seedFromText(code));
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);

function showMenu(linkedMap?: string | null): void {
  loadSettings();
  // "Rematch" from an end screen: what to skip straight into (read below)
  let token: string | null = null;
  try {
    token = sessionStorage.getItem(REMATCH_KEY);
    sessionStorage.removeItem(REMATCH_KEY);
  } catch {
    /* ignore */
  }
  // a sound duel's Rematch (SOUND-DUEL.md "Rematch"): before any audio context exists, link mode (the boot has
  // put the audio session back to "auto" already: Safari keeps a page's session type across a reload, and a
  // context made while it is play-and-record can take its rate from a snapshot of 16 kHz, src/link/rig.ts "The
  // rate"). The menu's sound waits for the reconnect tap. (A practice link opens no rig and no guard, so no
  // link mode.)
  const duelRematch = token === DUEL_REMATCH;
  const onlineRematch = duelRematch && rematchIsOnline();
  if (duelRematch && !duelPractice && !onlineRematch) sfx.linkMode = true;
  // ?map=<id> (a shared random map, or any built-in): preselect it and keep it as the pick
  if (linkedMap && isKnownMapId(linkedMap)) {
    gameMode.mapId = linkedMap;
    if (gameMode.mode === "ops") gameMode.mode = "skirmish";
    saveSettings();
  }
  const rnd = loadRandomPrefs();
  /** The map behind the 🎲 card: the pick if it's generated, else the last one seen, else a fresh roll. */
  let randomId = isRandomMapId(gameMode.mapId) && isKnownMapId(gameMode.mapId)
    ? gameMode.mapId
    : rnd.recent[0]?.id ?? rollRandomMapId(rnd.biome ?? undefined);
  const remember = (id: string) => {
    rnd.recent = [{ id, name: mapById(id).name }, ...rnd.recent.filter((r) => r.id !== id)].slice(0, RECENT_MAX);
    saveRandomPrefs(rnd);
  };
  if (randomId === gameMode.mapId) remember(randomId);
  const hud = document.getElementById("hud")!;
  const menu = document.createElement("div");
  menu.id = "splash";
  menu.className = "menu";
  const diffs = Object.keys(DIFFICULTY) as Difficulty[];
  menu.innerHTML = `
    <div class="keyart"></div>
    <button class="round menu-mute" id="menu-mute" title="Tout couper">🔊</button>
    <div class="menu-inner">
      <h1 class="logo panache">PANACHE</h1>
      <div class="menu-side" id="menuside">
        <button class="rankbadge" id="rankbadge"></button>
        <div class="dailyop" id="dailyop"></div>
        <button class="mutbtn side"></button>
      </div>
      <p class="sub" id="sub"></p>
      <div class="seg modes" id="gmode">
        <button data-m="skirmish">⚔ Escarmouche</button>
        <button data-m="survival">🛡 Survie</button>
        <button data-m="ops">🎖 Opérations</button>
      </div>
      <p class="lsbest" id="lsbest" hidden></p>
      <p class="lsbest opsum" id="opsum" hidden></p>
      <div class="maps opcards" id="opcards" hidden></div>
      <p class="blurb opblurb" id="opblurb" hidden></p>
      <div class="maps" id="maps">
        ${MAPS.map(
          (m) => `
          <button class="mapcard" data-id="${m.id}">
            <img src="${mapThumbUrl(m.id)}" alt="" draggable="false" />
            <span class="mn">${m.name}</span>
            <span class="mb">${m.size}×${m.size} · ${BIOME_FR[m.biome]}</span>
            <span class="mbest" hidden></span>
            <span class="mstars" hidden></span>
          </button>`
        ).join("")}
        <button class="mapcard rndcard" data-id="${randomId}" id="rndcard">
          <img src="" alt="" draggable="false" />
          <span class="mfog" aria-hidden="true"><b>?</b></span>
          <span class="mzoom" aria-hidden="true"><i>🔍</i></span>
          <span class="mn"></span>
          <span class="mb"></span>
          <span class="mbest" hidden></span>
          <span class="mstars" hidden></span>
          <span class="mrnd">🎲 Aléatoire</span>
        </button>
      </div>
      <div class="rndpanel" id="rndpanel" hidden>
        <div class="seg rndbiome" id="rndbiome">
          <button data-b="" title="Les relances choisissent n'importe quel biome">🎲 Tous</button>
          ${BIOMES.map((b) => `<button data-b="${b}" title="${cap(BIOME_FR[b])}">${BIOME_ICON[b]}<span> ${cap(BIOME_FR[b])}</span></button>`).join("")}
        </div>
        <div class="rndrow">
          <label class="rndseed" title="Graine : tape ou colle un code pour générer cette carte">#<input id="rndseed" type="text" inputmode="text" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="40" /></label>
          <button class="cta alt" id="rndroll">🎲 Relancer</button>
          <button class="cta alt" id="rndcopy">🔗 Copier le lien</button>
        </div>
        <p class="rndhint"><b>Avant de jouer</b> <span id="rndhint"></span></p>
        <div class="rndrow">
          <div class="seg rndview" id="rndview" role="radiogroup" aria-label="Avant de jouer">
            <button data-u="0" role="radio" title="Voir toute la carte avant le match">👁️ Aperçu</button>
            <button data-u="1" role="radio" title="La carte reste noire tant que tu ne l'as pas explorée">🌫️ Inconnue</button>
          </div>
          <button class="cta alt" id="rndfull">🔍 Voir<span class="wide"> toute la</span> carte</button>
        </div>
        <div class="rndrecent" id="rndrecent"></div>
      </div>
      <p class="blurb" id="blurb"></p>
      <div class="seg" id="diff">
        ${diffs.map((d) => `<button data-d="${d}">${DIFFICULTY[d].label}</button>`).join("")}
      </div>
      <button class="mutbtn main"></button>
      <button class="cta big" id="play">▶ Jouer</button>
      <div class="row" id="duelrow" hidden><button class="cta alt" id="play-duel" disabled>🔊 Défier un ami (son)</button><button class="cta alt" id="play-online" disabled>🌐 Défier un ami (en ligne)</button></div>
      <div class="row">
        <button class="cta alt" id="play-tuto" title="L'instruction guidée : un geste à la fois, 3 minutes">🎓 Instruction</button>
        <button class="cta alt" id="play-spectate">🤖 IA contre IA</button>
        <button class="cta alt" id="play-replay">🎬 Voir une rediffusion</button>
        <button class="cta alt" id="howto">? Comment jouer</button>
      </div>
      <div class="help" id="helpbox" hidden>${HELP_HTML}</div>
      ${BELLE_EPOQUE ? `<button class="linkbtn" id="replay-intro" type="button">🎞 Revoir l'intro</button>` : ""}
      <p class="credits">D'après <a href="https://github.com/simonw/battledrones" target="_blank" rel="noopener">Battle Drones</a> de Simon Willison · visuels OpenAI gpt-image-2.5 · son synthétisé en direct</p>
    </div>
  `;
  hud.appendChild(menu);
  /** The menu music waits for the title's logo slam (Belle Époque: ui/title.ts). */
  let musicGo = true;
  if (BELLE_EPOQUE) {
    // the living title scene in place of the key art; press-start and the cinematic, unless skipping into a game
    const title = mountTitle(
      menu,
      {
        slam: () => {
          musicGo = true;
          const biome = biomeOf(shownMap());
          menuBiome = biome;
          music.play("menu", biome, true);
        },
        replay: () => {
          musicGo = false;
          menuBiome = null;
          music.stop();
        }
      },
      token !== null || !!salonLink
    );
    musicGo = !title.waiting;
  } else {
    // inline, document-relative URLs keep GitHub Pages subpaths working
    const art = menu.querySelector<HTMLElement>(".keyart")!;
    const landscape = window.matchMedia("(orientation: landscape)");
    const setArt = () =>
      (art.style.backgroundImage = `url(assets/ui/keyart-${landscape.matches ? "landscape" : "portrait"}.webp)`);
    setArt();
    landscape.addEventListener("change", setArt);
  }

  // menu music: a gentle take on the selected map's theme, from the first touch
  const biomeOf = (id: string) => mapById(id).biome;
  if (!duelRematch || onlineRematch) sfx.unlockOnGesture();
  const muteBtn = menu.querySelector<HTMLButtonElement>("#menu-mute")!;
  const syncMute = () => (muteBtn.textContent = sfx.muted ? "🔇" : "🔊");
  syncMute();
  const offMute = sfx.onChange(syncMute);
  muteBtn.addEventListener("click", () => sfx.setMuted(!sfx.muted));
  const offUpdate = mountUpdatePill(menu);
  // the duel buttons (Skirmish only), over sound and online, disabled until their chunk is in
  const duelable = canDuel();
  const onlineable = canDuelOnline();
  const duelRow = menu.querySelector<HTMLElement>("#duelrow")!;
  const duelBtn = menu.querySelector<HTMLButtonElement>("#play-duel")!;
  const onlineBtn = menu.querySelector<HTMLButtonElement>("#play-online")!;
  duelBtn.hidden = !duelable;
  onlineBtn.hidden = !onlineable;
  let duel: typeof DuelLobby | null = null;
  let duelBroken = false;
  let duelLoaded = false;
  /** A lobby is open, or still saying the end after a Cancel past GO (up to 2 s): no second Duel or Rematch tap until it lets go. */
  let duelLive = false;
  const syncDuelBtn = () => {
    const on = duelLoaded && !duelLive;
    for (const b of [duelBtn, onlineBtn]) {
      b.disabled = !on;
      b.style.opacity = on ? "" : "0.6";
    }
  };
  if (duelable || onlineable || duelRematch) {
    syncDuelBtn();
    loadDuel()
      .then(
        (d) => void (duel = d),
        (e: unknown) => {
          console.warn("sound duel:", e);
          duelBroken = true; // (the tap says a new version is ready)
        }
      )
      .finally(() => {
        duelLoaded = true;
        syncDuelBtn();
      });
  }

  // career: rank badge, Daily Op card, mutator picker, map stars (ui/career.ts)
  const career = mountMenuCareer(menu, {
    playDaily: (op) => void begin(false, () => startDaily(op)),
    changed: () => saveSettings()
  });
  // Ops: op cards, progress line and the briefing sheet (ui/ops.ts)
  const ops = mountMenuOps(menu, {
    start: (op) => void begin(false, () => startOp(op)),
    selectedId: () => gameMode.opId,
    select: (id) => {
      gameMode.opId = id;
      saveSettings();
      sync(); // the Play button names the picked op
    }
  });
  /** Is this map offered in the mode picked (Last Stand isn't played on the island map)? */
  const offered = (id: string) => gameMode.mode !== "survival" || mapById(id).lastStand !== false;
  /** The map the menu shows and Play starts: the pick, or the first one offered in this mode. */
  const shownMap = () => (offered(gameMode.mapId) ? gameMode.mapId : MAPS.find((x) => offered(x.id))!.id);
  let menuBiome: string | null = null;
  // the map and Ops rows scroll sideways on phones: fade + chevrons say so
  const mapRow = scrollCue(menu.querySelector<HTMLElement>("#maps")!);
  scrollCue(menu.querySelector<HTMLElement>("#opcards")!);
  let revealed = "";
  let shownRandom = "";
  /**
   * The 🎲 card and the random-map panel follow randomId. Uncharted, the card
   * wears fog over a "?" and goes by "Uncharted": only the biome and the code
   * (to share or replay the seed) give anything away, and the thumbnail is
   * never painted.
   */
  function syncRandom(): void {
    const card = menu.querySelector<HTMLElement>("#rndcard")!;
    const def = mapById(randomId);
    const code = def.random?.code ?? seedCode(def.seed);
    const blind = gameMode.uncharted;
    const key = `${randomId}:${blind}`;
    if (shownRandom !== key) {
      shownRandom = key;
      card.dataset.id = randomId;
      card.dataset.biome = def.biome;
      card.classList.toggle("uncharted", blind);
      const img = card.querySelector("img")!;
      img.src = blind ? BLANK_IMG : mapThumbUrl(randomId);
      card.querySelector(".mn")!.textContent = blind ? "Inconnue" : def.name;
      card.querySelector(".mb")!.textContent = `${RANDOM_MAP_SIZE}×${RANDOM_MAP_SIZE} · ${BIOME_FR[def.biome]} · #${code}`;
      card.title = blind ? `Inconnue (${BIOME_FR[def.biome]}, graine ${code})` : `${def.name} (${BIOME_FR[def.biome]}, graine ${code}) · touche encore pour voir toute la carte`;
    }
    menu.querySelectorAll<HTMLElement>("#rndview button").forEach((el) => {
      const on = (el.dataset.u === "1") === blind;
      el.classList.toggle("on", on);
      el.setAttribute("aria-checked", String(on));
    });
    menu.querySelector<HTMLElement>("#rndfull")!.hidden = blind;
    menu.querySelector("#rndhint")!.textContent = blind
      ? "Pars à l'aveugle : explore pour révéler la carte."
      : "Étudie d'abord toute la carte.";
    const box = menu.querySelector<HTMLInputElement>("#rndseed")!;
    if (document.activeElement !== box) box.value = code;
    menu.querySelectorAll<HTMLElement>("#rndbiome button").forEach((el) => el.classList.toggle("on", (el.dataset.b || null) === rnd.biome));
    menu.querySelector("#rndrecent")!.innerHTML = rnd.recent
      .map((r) => {
        const p = parseRandomMapId(r.id)!;
        const on = r.id === randomId ? " on" : "";
        // (uncharted: code and biome only, no names)
        const name = blind ? "" : `${esc(r.name)} `;
        const title = blind ? `Inconnue · ${BIOME_FR[p.biome]}` : `${esc(r.name)} · ${BIOME_FR[p.biome]}`;
        return `<button class="rndchip${on}" data-id="${r.id}" title="${title}">${BIOME_ICON[p.biome]} ${name}<b>#${seedCode(p.seed)}</b></button>`;
      })
      .join("");
  }
  const sync = () => {
    const survival = gameMode.mode === "survival";
    const opsMode = gameMode.mode === "ops";
    career.sync();
    for (const id of ["#opsum", "#opcards", "#opblurb"]) menu.querySelector<HTMLElement>(id)!.hidden = !opsMode;
    for (const id of ["#maps", "#blurb", "#diff"]) menu.querySelector<HTMLElement>(id)!.hidden = opsMode;
    syncRandom();
    ops.sync();
    menu.querySelector<HTMLElement>("#play-spectate")!.hidden = opsMode;
    duelRow.hidden = !(duelable || onlineable) || gameMode.mode !== "skirmish";
    menu.classList.toggle("ops-mode", opsMode);
    // Last Stand isn't offered on every map (the island map): show the first that is, without
    // losing the skirmish pick (Play points the match at the shown map: see begin)
    const shown = shownMap();
    menu.querySelectorAll<HTMLElement>("#maps .mapcard").forEach((el) => {
      el.hidden = !offered(el.dataset.id!);
      el.classList.toggle("on", el.dataset.id === shown);
      // Last Stand: each map card shows its best for the chosen difficulty
      const badge = el.querySelector<HTMLElement>(".mbest")!;
      const rec = survival ? loadBest(el.dataset.id!, gameMode.difficulty) : null;
      badge.hidden = !rec;
      badge.textContent = rec ? `🛡 ${rec.best}` : "";
      // (generated maps earn no stars: there are endlessly many)
      const stars = el.querySelector<HTMLElement>(".mstars")!;
      const noStars = survival || isRandomMapId(el.dataset.id!);
      const mask = noStars ? 0 : career.starsFor(el.dataset.id!);
      stars.hidden = noStars;
      stars.textContent = starsText(mask);
      stars.classList.toggle("got", mask > 0);
    });
    // bring the picked map into view when the row first shows (or shows again)
    const pick = menu.querySelector<HTMLElement>(`#maps .mapcard[data-id="${shown}"]`);
    const key = opsMode ? "" : `${gameMode.mode}:${shown}`;
    if (key && key !== revealed && pick) {
      const smooth = revealed !== ""; // (opening the menu: already centred, no slide)
      requestAnimationFrame(() => mapRow.reveal(pick, smooth));
      revealed = key;
    }
    // the menu theme follows the map on show
    const biome = biomeOf(shown);
    if (musicGo && biome !== menuBiome) {
      menuBiome = biome;
      music.play("menu", biome);
    }
    menu.querySelectorAll<HTMLElement>("#diff button").forEach((el) => el.classList.toggle("on", el.dataset.d === gameMode.difficulty));
    menu.querySelectorAll<HTMLElement>("#gmode button").forEach((el) => el.classList.toggle("on", el.dataset.m === gameMode.mode));
    const m = mapById(shown);
    const blind = gameMode.uncharted && isRandomMapId(shown);
    menu.querySelector("#blurb")!.textContent = blind ? "Un champ de bataille inconnu. Explore-le pour en découvrir la forme." : m.blurb;
    menu.querySelector<HTMLElement>("#rndpanel")!.hidden = opsMode || !isRandomMapId(shown);
    menu.querySelector("#sub")!.textContent = opsMode
      ? "Des missions courtes à rebondissement. Trois étoiles chacune : sauras-tu toutes les prendre ?"
      : survival
        ? "Tiens ta base face à des vagues sans fin. Combien de temps tiendras-tu ?"
        : "Extrais le charbon. Bâtis ton escadre. Détruis le GQG ennemi et ses Gargantuas.";
    const best = menu.querySelector<HTMLElement>("#lsbest")!;
    best.hidden = !survival;
    if (survival) {
      const rec = loadBest(shown, gameMode.difficulty);
      const where = `${blind ? `Inconnue #${m.random?.code ?? ""}` : m.name} · ${DIFFICULTY[gameMode.difficulty].label}`;
      best.innerHTML = rec
        ? `🏆 Record sur ${where} : <b>${rec.best} vague${rec.best === 1 ? "" : "s"}</b>`
        : `Aucun record sur ${where} : établis-en un !`;
    }
    const sel = ops.selected();
    menu.querySelector("#play")!.textContent = opsMode
      ? ops.locked(sel) ? "🔒 Verrouillée" : `▶ Op : ${sel.title}`
      : survival ? "▶ Lancer la Survie" : "▶ Jouer";
    menu.querySelector("#play")!.classList.toggle("locked", opsMode && ops.locked(sel));
    menu.querySelector("#play-spectate")!.textContent = survival ? "🤖 Voir l'IA défendre" : "🤖 IA contre IA";
  };
  sync();
  menu.querySelectorAll<HTMLElement>("#maps .mapcard").forEach((el) =>
    el.addEventListener("click", () => {
      // a second tap on the picked 🎲 card opens the full-map preview
      if (el.id === "rndcard" && el.classList.contains("on") && !gameMode.uncharted) return previewRandom();
      gameMode.mapId = el.dataset.id!;
      if (isRandomMapId(gameMode.mapId)) remember(gameMode.mapId);
      saveSettings();
      sync();
    })
  );
  // random maps: biome, seed, reroll, link, recent picks
  const pickRandom = (id: string) => {
    randomId = gameMode.mapId = id;
    remember(id);
    saveSettings();
    sfx.play("click", 0.5);
    sync();
  };
  menu.querySelectorAll<HTMLElement>("#rndbiome button").forEach((el) =>
    el.addEventListener("click", () => {
      const b = (el.dataset.b || null) as Biome | null;
      rnd.biome = b;
      saveRandomPrefs(rnd);
      // a biome keeps the seed (same code, new world); "Any" just frees the rerolls
      const p = parseRandomMapId(randomId);
      if (b && p && p.biome !== b) pickRandom(randomMapId(b, p.seed));
      else syncRandom();
    })
  );
  const seedBox = menu.querySelector<HTMLInputElement>("#rndseed")!;
  seedBox.addEventListener("change", () => {
    const biome = rnd.biome ?? parseRandomMapId(randomId)?.biome ?? "temperate";
    if (seedBox.value.trim()) pickRandom(idFromSeedText(seedBox.value, biome));
    else syncRandom(); // (emptied: show the code back)
  });
  seedBox.addEventListener("keydown", (e) => e.key === "Enter" && seedBox.blur());
  menu.querySelector("#rndroll")!.addEventListener("click", () => pickRandom(rollRandomMapId(rnd.biome ?? undefined)));
  const copyBtn = menu.querySelector<HTMLButtonElement>("#rndcopy")!;
  let copiedTimer = 0;
  copyBtn.addEventListener("click", () => {
    sfx.play("click", 0.5);
    void navigator.clipboard
      ?.writeText(mapLink(randomId))
      .then(() => {
        copyBtn.textContent = "✓ Copié !";
        clearTimeout(copiedTimer);
        copiedTimer = window.setTimeout(() => (copyBtn.textContent = "🔗 Copier le lien"), 1600);
      })
      .catch(() => {
        /* no clipboard (insecure context, denied): fail quietly */
      });
  });
  // before you play: see the whole map (Preview), or go in blind (Uncharted)
  menu.querySelectorAll<HTMLElement>("#rndview button").forEach((el) =>
    el.addEventListener("click", () => {
      const blind = el.dataset.u === "1";
      if (blind === gameMode.uncharted) return;
      gameMode.uncharted = blind;
      saveSettings();
      sfx.play("click", 0.5);
      sync();
    })
  );
  /** The full-map preview of the 🎲 card's map: Play starts it as Play does, Reroll keeps the menu in step. */
  const previewRandom = () => {
    if (gameMode.uncharted) return;
    sfx.play("click", 0.5);
    openMapPreview(mapById(randomId), {
      host: menu,
      playLabel: gameMode.mode === "survival" ? "▶ Lancer la Survie" : "▶ Jouer cette carte",
      onPlay: () => {
        gameMode.mapId = randomId;
        saveSettings(); // (a Rematch reloads the saved pick)
        void begin(false);
      },
      onReroll: () => {
        pickRandom(rollRandomMapId(rnd.biome ?? undefined));
        return mapById(randomId);
      }
    });
  };
  menu.querySelector("#rndfull")!.addEventListener("click", previewRandom);
  menu.querySelector("#rndrecent")!.addEventListener("click", (e) => {
    const id = (e.target as HTMLElement).closest<HTMLElement>("[data-id]")?.dataset.id;
    if (id && isKnownMapId(id)) pickRandom(id);
  });
  menu.querySelectorAll<HTMLElement>("#diff button").forEach((el) =>
    el.addEventListener("click", () => {
      gameMode.difficulty = el.dataset.d as Difficulty;
      saveSettings();
      sync();
    })
  );
  menu.querySelectorAll<HTMLElement>("#gmode button").forEach((el) =>
    el.addEventListener("click", () => {
      gameMode.mode = el.dataset.m as GameType;
      sfx.play("click", 0.5);
      saveSettings();
      sync();
    })
  );
  menu.querySelector("#howto")!.addEventListener("click", () => {
    const h = menu.querySelector<HTMLElement>("#helpbox")!;
    h.hidden = !h.hidden;
  });

  // one match per page: a second tap while the full-screen request is
  // pending (Android takes a moment) must not boot a second game
  let starting = false;
  const begin = async (spectator: boolean, setup?: () => void, feed?: MatchFeed) => {
    if (starting) return;
    starting = true;
    // a Last Stand on a map it isn't offered on plays the shown one (not saved: the pick stays)
    if (!setup && !offered(gameMode.mapId)) gameMode.mapId = shownMap();
    setup?.(); // (the Daily Op / an op points the match at its map and rules)
    gameMode.spectator = spectator;
    sfx.unlock();
    // (a duel: its tap asked for full screen already, and no click goes out over the link)
    if (feed?.local === undefined) {
      sfx.play("click");
      await fullscreen.enter(); // (Android/desktop; iOS Safari's dvh layout covers it)
    }
    offMute();
    offUpdate();
    menu.remove();
    void startGame(feed);
  };
  const play = () => {
    if (gameMode.mode !== "ops") return void begin(false);
    const op = ops.selected();
    sfx.play("click", 0.5);
    if (!ops.locked(op)) ops.openBrief(op);
  };
  // L'Instruction: offered on the first Jouer of a new player (never to a robot: the smoke test and tools play on)
  const startTuto = () => void begin(false, startTutorial);
  menu.querySelector("#play")!.addEventListener("click", () => {
    if (tutorialState() === null && navigator.webdriver !== true && loadCareer().xp === 0) {
      sfx.play("click", 0.5);
      return showTutorialPrompt(menu, startTuto, () => {
        setTutorialState("no");
        play();
      });
    }
    play();
  });
  const tutoBtn = menu.querySelector<HTMLElement>("#play-tuto")!;
  if (tutorialState() === "done") tutoBtn.textContent = "🎓 Instruction ✓";
  tutoBtn.addEventListener("click", startTuto);
  menu.querySelector("#play-spectate")!.addEventListener("click", () => begin(true));
  // an agent battle's record, pasted or picked: the viewer loads only now (game/replay.ts)
  menu.querySelector("#play-replay")!.addEventListener("click", () => {
    sfx.play("click", 0.5);
    showReplayPicker(menu, async (json) => {
      const { replayFromJson } = await import("./game/replay");
      const feed = replayFromJson(json);
      await begin(true, () => watchSetup(feed), feed);
    });
  });

  // ------------------------------------------------------------ sound duel ---
  /** The duel's match: main's begin, with the agreed map, mutators and side (never saved). */
  const startDuel = (feed: VersusFeed) => void begin(false, () => duelSetup(feed.config), feed);
  let rematchScreen: HTMLElement | null = null;
  /** The Duel tap's full screen, armed for the next tap once the rig has the microphone. */
  let disarmFullscreen: (() => void) | null = null;
  /** The lobby let the duel's audio go with no match (Cancel, an error, the rematch's fallback), or the rematch was declined: the menu again. */
  const duelClosed = () => {
    duelLive = false;
    disarmFullscreen?.();
    disarmFullscreen = null;
    // (a game began from the menu while a lobby still said the end, after a Cancel past GO: the menu and its music
    // are gone, the game's own music plays, and the lobby has let the rig, the guard and link mode go itself)
    if (starting) return;
    syncDuelBtn();
    rematchScreen?.remove();
    rematchScreen = null;
    // (the rig's close() already did, if one was opened, and so did the boot; the rematch boot's Menu opened none)
    resetAudioSession();
    sfx.linkMode = false;
    sfx.unlockOnGesture();
    music.play("menu", biomeOf(shownMap()));
  };
  /**
   * The Duel tap, synchronously, in this order (SOUND-DUEL.md "The tap"); `rematch`: the rematch's reconnect tap;
   * `online`: the online duel's button (no rig, no guard), `code` the room an invite link brought.
   */
  const duelTap = (d: typeof DuelLobby, rematch: boolean, online = false, code: string | null = null) => {
    // (one lobby at a time: an old one's late release would turn the new one's guard and link mode off)
    if (duelLive) return;
    duelLive = true;
    syncDuelBtn();
    const tap = d.tapPlan(rematch, online);
    // the game's context before the rig's play-and-record, as the rig's own (src/link/rig.ts "The rate"): from
    // the menu the first touch has made it already and this only resumes it, but the rematch boot makes none
    // until this tap, and after the rig it would be born under play-and-record
    sfx.unlock();
    const rig = tap.practice || tap.online ? null : d.openRig({ micMode: tap.micMode });
    if (rig)
      try {
        sfx.setLinkGuard("high");
      } catch (e) {
        console.warn("link guard:", e); // (the duel goes on without it)
      }
    music.stop();
    // full screen: a practice link's at once (last: it consumes the activation), the rig's on the first tap once
    // it has the microphone, as on iPadOS a full-screen page hides the microphone prompt
    if (!rig) void fullscreen.enter();
    else
      rig.ready.then(
        () => {
          if (!duelLive || rig.state === "closed") return; // (this lobby let it go)
          disarmFullscreen?.();
          disarmFullscreen = fullscreen.enterOnGesture();
        },
        () => undefined // (the lobby tells it)
      );
    const o = {
      host: menu, rig, shownMap: shownMap(), mutators: activeMutators(), start: startDuel, onClose: duelClosed,
      online: tap.online ? { code } : null
    };
    if (rematch) d.reconnect(o);
    else d.showLobby(o);
  };
  const duelUpdate = () => {
    const wrap = openSheet(
      menu,
      "duelupdate",
      `<h2>🔊 Défier un ami</h2>
       <p class="sh-sub">${DUEL_UPDATE}</p>
       <div class="sh-actions"><button class="cta alt sheet-close">Fermer</button><button class="cta" id="duel-reload">Recharger</button></div>`
    );
    wrap.querySelector("#duel-reload")!.addEventListener("click", () => fullscreen.reload());
  };
  duelBtn.addEventListener("click", () => {
    if (duel) duelTap(duel, false);
    else if (duelBroken) duelUpdate();
  });
  onlineBtn.addEventListener("click", () => {
    if (duel) duelTap(duel, false, true);
    else if (duelBroken) duelUpdate();
  });
  // an invite link (?salon=ABCD): the online lobby opens on its code, its Join one tap away
  if (salonLink && !duelRematch && onlineable) {
    gameMode.mode = "skirmish";
    void loadDuel().then(
      (d) => {
        if (!starting) duelTap(d, false, true, salonLink);
      },
      () => duelUpdate()
    );
  }
  // a duel's Rematch: one button, whose tap is the Duel tap paired with the stored role and plan
  if (duelRematch) {
    music.stop();
    const scr = (rematchScreen = document.createElement("div"));
    scr.className = "screen";
    scr.style.position = "fixed"; // (over the menu, which scrolls)
    scr.innerHTML = `<div class="loadbox">
        <button class="cta big" id="duel-rematch" disabled>${
          // (a practice link has no sound to reconnect and asks for no microphone)
          duelPractice ? "Revanche · touche pour lancer" : "Revanche · touche pour te reconnecter<br /><small>(autorise le micro si demandé)</small>"
        }</button>
        <button class="cta alt" id="duel-menu">Menu</button>
      </div>`;
    menu.appendChild(scr);
    const btn = scr.querySelector<HTMLButtonElement>("#duel-rematch")!;
    btn.addEventListener("click", () => {
      if (duel) duelTap(duel, true);
      else if (duelBroken) duelUpdate();
    });
    void loadDuel().then(
      (d) => {
        btn.disabled = false;
        // (an online rematch: no microphone, the same room)
        if (d.tapPlan(true).online) btn.textContent = "Revanche · touche pour retrouver ton ami";
      },
      () => {
        btn.disabled = false;
        btn.textContent = DUEL_UPDATE;
      }
    );
    // (declined: no rig was opened, so duelClosed puts the audio session back itself)
    scr.querySelector("#duel-menu")!.addEventListener("click", () => {
      if (!duelLive) duelClosed();
    });
  }

  // "Rematch" from the end screen skips straight back into a game
  let rematch = false;
  try {
    const op = token?.startsWith("op:") ? opById(token.slice(3)) : null;
    rematch = token === "1" || token === "spectate" || token === "daily" || !!op;
    if (token === "spectate") gameMode.spectator = true; // another AI-vs-AI match
    if (token === "daily") startDaily(dailyOp(today()));
    if (op?.tutorial) startTutorial();
    else if (op) startOp(op);
  } catch {
    /* ignore */
  }
  if (rematch) {
    offMute();
    offUpdate();
    menu.remove();
    void startGame();
    // audio needs a gesture: sfx.unlockOnGesture() (above) starts it on the first touch
  }
}

/**
 * `/?replay=<record>`, in every build: fetch a battle record by its link
 * (relative to the game, any CORS-enabled URL, a file on GitHub or a Gist) and
 * watch it. Its Menu buttons leave the link behind (ui/fullscreen.ts).
 */
async function watchLinked(url: string, follow: boolean): Promise<void> {
  const note = document.createElement("div");
  note.className = "screen";
  note.innerHTML = `<div class="loadbox"><p>Chargement de l'enregistrement…</p></div>`;
  document.getElementById("hud")!.appendChild(note);
  const feed = await import("./game/replay")
    .then((m) => m.loadReplay(url, follow))
    .catch((e: unknown) => {
      note.innerHTML = `<div class="panel"><p class="time"></p><button class="cta">Menu principal</button></div>`;
      note.querySelector("p")!.textContent = `Impossible de lire cet enregistrement. ${e instanceof Error ? e.message : String(e)}`;
      note.querySelector("button")!.addEventListener("click", () => location.assign("./"));
      return null;
    });
  if (!feed) return;
  note.remove();
  watchSetup(feed);
  sfx.unlockOnGesture(); // (no menu was tapped: the sound starts on the first touch)
  await startGame(feed);
}

/** Point the next match at a battle replay's map and rules (not saved: the player's own picks stay). */
function watchSetup(feed: { record: { map: string; mutators: MutatorId[] } }): void {
  Object.assign(gameMode, { mapId: feed.record.map, spectator: true, mode: "skirmish", mutators: feed.record.mutators, daily: null, op: null });
}

/** Point the next match at an op (not saved: the op fixes map, enemy and rules). */
function startOp(op: OpDef): void {
  // remember the pick (and the Ops tab) before the op's own map and difficulty take over
  gameMode.opId = op.id;
  gameMode.mode = "ops";
  saveSettings();
  gameMode.op = op;
  gameMode.mapId = op.map;
  gameMode.difficulty = op.ai && op.ai !== "survival" ? op.ai.difficulty : op.survival?.difficulty ?? "normal";
}

/** Point the next match at the Instruction (not saved: the menu's picks stay as they were). */
function startTutorial(): void {
  Object.assign(gameMode, { op: TUTORIAL_OP, mapId: TUTORIAL_OP.map, difficulty: "easy", daily: null, spectator: false });
}

/** Point the next match at the Daily Op (not saved: the player's own picks stay). */
function startDaily(op: DailyOp): void {
  gameMode.daily = op;
  gameMode.mapId = op.mapId;
  gameMode.difficulty = op.difficulty;
  gameMode.mode = "skirmish";
}

// The battle viewer for agent battles (AGENT-BATTLES.md "Watching") by a record's link, in every build:
// /?replay=<record> (watchLinked). &follow, a live battle on the dev server, is dev-only: production builds
// drop it (import.meta.env.DEV is false there).
const params = new URLSearchParams(location.search);
const replayLink = params.get("replay")?.trim();
if (replayLink) void watchLinked(replayLink, import.meta.env.DEV && params.has("follow"));
else {
  // /?map=<id> (the random map panel's 🔗 link): preselect that map once; the saved pick carries it after
  const linkedMap = params.get("map")?.trim().toLowerCase();
  // (?salon=, an online duel's invite, is read already: salonLink; a reload mustn't join again)
  if (params.has("map") || params.has("salon")) {
    params.delete("map");
    params.delete("salon");
    const q = params.toString();
    history.replaceState(null, "", `${location.pathname}${q ? `?${q}` : ""}${location.hash}`);
  }
  showMenu(linkedMap);
}
