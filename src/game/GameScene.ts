import * as THREE from "three";
import { behaves, nationKind } from "../sim/nations";
import { nationOf } from "../sim/rules";
import { agree, displayName } from "../sim/lexicon";
import { DIFFICULTY, createAiState, tickAi, type AiState } from "../sim/ai/commander";
import { BUILDINGS, ECONOMY, GOLIATH, ROLES, TICK_RATE, UNITS } from "../sim/balance";
import { canPlaceBuilding, nearestReachableResource } from "../sim/economy";
import { isExplored, isVisible, tickFog } from "../sim/fog";
import { unitSeenBy } from "../sim/infantry";
import { createMapWorld, mapById } from "../sim/maps";
import { OPENERS, OPENER_IDS, allowedOpener, applyOpener, openerBlocked, pickAiOpener, type OpenerId } from "../sim/openers";
import { step } from "../sim/sim";
import type { Building, Command, Faction, FxEvent, Unit, World } from "../sim/types";
import type { BattleRecord, PlayedInfo } from "../arena/record";
import { MatchRecorder, BUILD_SIM_HASH } from "./match-record";
import { reelMoments } from "./reel";
import { archiveMatch, archives } from "./archive";
import { addReportSection } from "../ui/report";
import { reelSection } from "../ui/reel-entry";
import { buildingCenter, domainOf, hqOf } from "../sim/world";
import { sfx } from "./audio";
import { Controller, ENEMY, PLAYER, type TapHit } from "./controller";
import { applyOpenersCanonical, composeTick } from "./local-side";
import { GestureRecognizer, isHoldRelease, strandedPointers, type GesturePointer } from "./gestures";
import { announce } from "./announce";
import { gameMode, matchOptions, unchartedMatch } from "./mode";
import { music } from "./music";
import { BattleMood } from "./score";
import { voices, type VoiceHooks } from "./voices";
import { Announcer } from "./announcer";
import { voicePack } from "./voice-pack";
import { Awareness } from "./awareness-view";
import { baseGoliath, calldownThreatens, planTicks } from "./awareness";
import { HINTS } from "./hints";
import { SurvivalPresenter, finishRun } from "./survival";
import { chronicleOf, placeName, type Chronicle } from "./chronicle";
import { SPOTLIGHT, Spotlight, spotlightOn, type Spot } from "./spotlight";
import { CINE_KEY, Director } from "./director";
import { FINALE, Finale, LOVE_FINALE, finaleBanner, finaleOutcome, finaleZoom, freeAreaOffset, type FinaleCause } from "./finale";
import { HeroPresenter } from "./hero-fx";
import { aiSeed, aiStrategy, announceRules, opEnemyAi, settleCareer } from "./meta";
import { OpsPresenter } from "./ops";
import { TutorialView } from "./tutorial-view";
import { fullscreen } from "../ui/fullscreen";
import { EntityRenderer } from "./render/entities";
import { Fx } from "./render/fx";
import { CombatJuice } from "./render/juice-view";
import { WreckRenderer } from "./render/wrecks";
import { PowerRenderer } from "./render/powers";
import { ObjectiveRenderer } from "./render/objectives";
import { createHud, type DuelHud, type EndOpts, type Hud } from "../ui/hud";
import { PlacementView } from "./placement-view";
import { CommandUi } from "../ui/command";
import { nationText, showOpenerPicker, type Words } from "../ui/openers";
import { createPowerPanel, type PowerPanel } from "../ui/powers";
import { createObjectivePill, type ObjectivePill } from "../ui/objectives";
import { mountCineToggle, type CineToggle } from "../ui/cinecam";
import { fitZoom, homeBox, hudInsets, startBox } from "./framing";
import { BELLE_EPOQUE } from "./three/theme";
import { Stage } from "./three/stage";
import { Terrain3D, type TerrainArt } from "./three/terrain";
import { Particles } from "./three/particles";
import { GroundGfx } from "./three/ground-gfx";
import { RouteSketch, drawQueuedRoute } from "./route-view";
import { Tweens } from "./three/tween";
import { AIR_H, type P3, type View } from "./three/view";

const TICK_MS = 1000 / TICK_RATE;
/** Zoom range in CSS px per tile at the look-at point. */
const MIN_ZOOM = 18;
const MAX_ZOOM = 110;
const DEFAULT_ZOOM = 42;
/** The look-at point may wander this far past the map edge (tiles). */
const EDGE_PAD = 2;
/** Radius of an order's waypoint ring (CSS px). */
const WAYPOINT_PX = 7;
/** Production meters in the producer's side colour (blue is blue on both phones of a sound duel). */
const METER: Record<Faction, string> = { blue: "#6eb0ff", red: "#ff7a6a" };
/** Box-select dashes (CSS px), their dark rims (each 1 px longer at both ends), and none. */
const DASH = [6, 4];
const DASH_RIM = [8, 2];
const NO_DASH: number[] = [];

/**
 * A match played from outside instead of by the AI commanders: the battle
 * viewer (src/game/replay.ts, AGENT-BATTLES.md "Watching") feeds a recorded
 * battle through this, and spectator rules apply. A sound duel's feed
 * (src/versus/feed.ts, SOUND-DUEL.md "MatchFeed and GameScene") is an
 * interactive one: it sets `local`, and this phone plays that side, its
 * orders and the friend's arriving through commands(). Every scene branch for
 * it tests `feed?.local !== undefined`, so watched matches run as before.
 */
export interface MatchFeed {
  /** The world, set up as the fed match was. */
  readonly world: World;
  /** Who plays each side, for the spectator HUD. */
  readonly labels: Record<Faction, string>;
  /** This tick's commands, or null to hold here (a live battle not played this far yet). */
  commands(tick: number): Command[] | null;
  /** The scene is up: its controls, for the feed's own panel. */
  attach(scene: GameScene): void;
  /** After every step; `seeking` while skipping ahead with rendering off. */
  afterTick(w: World, seeking: boolean): void;
  /** Every frame. */
  frame(deltaMs: number): void;
  /** The latest saved copy of the world at or before `tick`, to rewind to (null: none). */
  keyframe(tick: number): World | null;
  /** This phone commands this side: an interactive feed (a duel), not a watched match. */
  readonly local?: Faction;
  /** Game speed this frame (a duel's slack trim around 1×). */
  speed?(): number;
  /** Who the opponent is, for labels ("your friend"). */
  readonly opponent?: string;
  /** A duel's pause menu and report buttons (ui/hud.ts DuelHud). */
  readonly duel?: DuelHud;
  /** After each frame is drawn, with the 3D view's canvas and the 2D overlay's (a highlight reel films them: ui/reel.ts). */
  rendered?(view: HTMLCanvasElement, overlay: HTMLCanvasElement): void;
  /** The finale is over: true when the feed shows what comes next itself (a highlight reel), instead of the report. */
  ended?(winner: Faction | "draw"): boolean;
  /** The match as a battle record to keep in the Archives once it's decided (a duel's: src/versus/feed.ts), or null. */
  saveable?(): BattleRecord | null;
}

/** Why a duel ended with no result (GameScene.abort): the worlds drifted apart, the friend left, or this phone left. */
export type AbortReason = "desync" | "left" | "lost";

/** The end screen's head for each abort (SOUND-DUEL.md "Hash trail", "Leaving"). */
const ABORT_HEAD: Record<AbortReason, { title: string; cls: "lose"; sub: string }> = {
  desync: { title: "DÉSYNCHRONISÉ", cls: "lose", sub: "Sans résultat : les deux parties ont divergé" },
  left: { title: "AMI PARTI", cls: "lose", sub: "Sans résultat" },
  lost: { title: "SIGNAL PERDU", cls: "lose", sub: "Tu es parti · Sans résultat" }
};

/**
 * The battle: the deterministic sim at a fixed 10 Hz, interpolated into a
 * three.js scene every animation frame, with touch/mouse/keyboard input,
 * the RTS camera, and every presenter (effects, audio, HUD, radio) fed
 * from the sim's events.
 */
export class GameScene {
  world!: World;
  ctrl!: Controller;
  /** The enemy commander, playing ENEMY (null in Last Stand and survival ops: the waves have none). */
  private ai: AiState | null = null;
  private blueAi: AiState | null = null;
  /** Whose fog of war the view shows when it's on (the player's; the battle viewer switches it). */
  private fogSide: Faction = PLAYER;
  /** Last Stand banners and spawn marker (null in skirmish). */
  private survival: SurvivalPresenter | null = null;
  /** Veteran promotions/deaths, the match record, and the HQ-kill cinematic. */
  private heroes!: HeroPresenter;
  private chronicle!: Chronicle;
  private finale: Finale | null = null;
  /** Single player's record of the match for the Archives (match-record.ts): a skirmish or the Daily Op against the AI, else null. */
  private recorder: MatchRecorder | null = null;
  /** Single player's Temps forts (spotlight.ts): null in a duel, a replay, AI vs AI, the Instruction, or switched off. */
  private spot: Spotlight | null = null;
  /** Where the match was decided (the deciding HQ or last Goliath's death), sized for what died. */
  private finaleAt: { x: number; y: number; size: number; cause: FinaleCause } | null = null;
  /** Ops: briefing banner, countdowns and star notices (null outside ops). */
  private ops: OpsPresenter | null = null;
  /** L'Instruction: the guided first mission's director (null in every other match). */
  private tutorial: TutorialView | null = null;
  private acc = 0;
  private prev = new Map<number, { x: number; y: number }>();
  readonly stage: Stage;
  readonly view: View;
  private terrain: Terrain3D;
  /** Building placement: ghost, suggested spot, touch move/drag/confirm. */
  private place!: PlacementView;
  /** Squad chips, counter/idle advisor badges. */
  private command!: CommandUi;
  private entities!: EntityRenderer;
  private fx!: Fx;
  private juice!: CombatJuice;
  /** Battle intensity for the adaptive score. */
  private mood!: BattleMood;
  /** The radio announcer (and the kill-streak callouts it owns). */
  private radio!: Announcer;
  private voiceHooks!: VoiceHooks;
  /** Game speed, inbound warnings, edge arrows, jump button, battle meter. */
  private aware!: Awareness;
  private wrecks!: WreckRenderer;
  /** Commander calldowns: reticles/effects, and the HUD buttons + targeting. */
  private powerFx!: PowerRenderer;
  private powerUi?: PowerPanel;
  /** Map objectives: Uplinks and supply crates (world view + the top-bar pill). */
  private objFx!: ObjectiveRenderer;
  private objPill: ObjectivePill | null = null;
  private gest!: GestureRecognizer;
  private boxRect: { x0: number; y0: number; x1: number; y1: number } | null = null;
  /** A route being drawn from the selection with one finger, then its waypoints fading (route-view.ts). */
  private sketch = new RouteSketch();
  /** This frame's order waypoints (one per shared target), reused: no per-frame garbage. */
  private waypoints: { key: number; x: number; y: number; col: number }[] = [];
  /** This frame's rank chevrons (x, y, scale per chevron), reused. */
  private chevrons: number[] = [];
  private hud!: Hud;
  private ended = false;
  /** A duel's no-result end (abort): no finale, no report of a winner. */
  private aborted: AbortReason | null = null;
  /** An interactive feed (a sound duel): this phone plays feed.local against a friend, not an AI. */
  private readonly interactive: boolean;
  /** The clock waits for the player's opener pick. */
  private holdStart = false;
  private simSeconds = 0;
  private lastAlert = -1e9;
  /** Smooth-zoom target and its screen anchor point (CSS px). */
  private targetZoom = DEFAULT_ZOOM;
  private zoomAnchor: { x: number; y: number } | null = null;
  /** AI vs AI: the cinematic camera's director (null when playing), whether it's switched on, and its 🎥 button. */
  private cine: Director | null = null;
  private cineOn = true;
  private cineUi: CineToggle | null = null;
  /** Pan momentum: CSS-px/frame velocity that decays after release. */
  private glide: { x: number; y: number } | null = null;
  private lastPan = { x: 0, y: 0 };
  private keys = new Set<string>();
  private teardown: (() => void)[] = [];
  private raf = 0;
  private lastFrame = 0;
  /** Cached visible-ground box for earshot (refreshed each frame). */
  private viewBox = { x0: 0, y0: 0, x1: 1, y1: 1 };

  constructor(parent: HTMLElement, readonly dpr: number, art: TerrainArt | null, private feed: MatchFeed | null = null) {
    document.getElementById("loading")?.remove();
    const opts = feed ? null : matchOptions();
    this.world = feed ? feed.world : createMapWorld(gameMode.mapId, opts!);
    this.ctrl = new Controller(this.world);
    const interactive = (this.interactive = feed?.local !== undefined);
    // (a duel's orders land D ticks after the tap: the build bar counts them meanwhile)
    if (interactive) this.ctrl.trackInFlight();
    // Uncharted: a generated map played blind, decided once here (a fed match or replay never is)
    const uncharted = !feed && unchartedMatch();

    // ---- the 3D view
    this.stage = new Stage(parent, dpr);
    this.stage.setBiome(this.world.biome);
    this.terrain = new Terrain3D(this.world, PLAYER, art, { uncharted });
    this.stage.scene.add(this.terrain.group);
    const particles = new Particles();
    this.stage.scene.add(particles.group);
    const heightAt = (x: number, y: number) => this.terrain.surfaceAt(x, y);
    const rig = this.stage.rig;
    const ground = new GroundGfx(rig, heightAt, { fog: true });
    const over = new GroundGfx(rig, heightAt, { order: 9 });
    const top = new GroundGfx(rig, heightAt, { onTop: true });
    this.stage.scene.add(ground.mesh, over.mesh, top.mesh);
    this.view = {
      stage: this.stage, scene: this.stage.scene, rig, tweens: new Tweens(), particles,
      terrain: this.terrain, screen: this.stage.screen, ground, over, top, dpr
    };

    if (this.world.survival)
      this.survival = new SurvivalPresenter(this.world, {
        mapId: gameMode.mapId,
        difficulty: this.world.survival.difficulty,
        spectator: gameMode.spectator || !!this.world.ops, // (no Last Stand records in an op)
        ping: (x, y) => this.hud?.ping(x, y),
        gfx: over
      });
    // spectating pits two Normal commanders against each other
    // mutators / the Daily Op decide which personalities can play (meta.ts)
    const aiDiff = gameMode.spectator ? "normal" : gameMode.difficulty;
    this.ai = this.world.survival || feed ? null : opEnemyAi() ?? createAiState(aiStrategy(aiDiff), aiDiff, aiSeed(1));
    // the match kept for the Archives and its highlight reel: a skirmish or the Daily Op against the AI (Last Stand,
    // ops and the Instruction start from setups a battle record can't describe; a duel's feed keeps its own)
    if (opts?.objectives && !gameMode.spectator && this.ai && !this.world.survival && !this.world.ops) {
      const handicap = DIFFICULTY[this.ai.difficulty].incomeMult;
      this.recorder = new MatchRecorder({
        setup: {
          map: this.world.mapId, seed: this.world.seed, mutators: opts.mutators?.slice() ?? [],
          ...(opts.nations ? { nations: { ...opts.nations } } : {}),
          // (tickAi sets the AI's income handicap every tick: the record carries it, as the arena's do)
          ...(handicap !== 1 ? { income: { [ENEMY]: handicap } } : {})
        },
        seats: { [PLAYER]: { player: "Toi" }, [ENEMY]: { player: "IA" } } as Record<Faction, { player: string }>,
        sim: BUILD_SIM_HASH,
        created: new Date().toISOString()
      });
    }
    if (gameMode.spectator) {
      this.blueAi = feed ? null : createAiState(aiStrategy("normal"), "normal", aiSeed(2));
      this.ctrl.spectator = true;
      this.ctrl.showFog = false; // watch the whole battle by default
    }
    // quick-start openers: spectated AIs take theirs at once; the player picks first
    // (skirmish and the Daily Op only: Last Stand and Ops set up their own starts)
    const openers: Partial<Record<"blue" | "red", OpenerId>> = {};
    if (this.world.survival || this.world.ops || feed) {
      /* no opener cards (a fed match was dealt its own) */
    } else if (this.blueAi && this.ai) {
      // (match rules may ban a pick, e.g. no Fab Plants under Air War: take an allowed one)
      openers.blue = allowedOpener(this.world, "blue", pickAiOpener(this.blueAi.strategy.name, this.world.seed, "blue")) ?? undefined;
      openers.red = allowedOpener(this.world, "red", pickAiOpener(this.ai.strategy.name, this.world.seed, "red")) ?? undefined;
      if (openers.blue) applyOpener(this.world, "blue", openers.blue);
      if (openers.red) applyOpener(this.world, "red", openers.red);
    } else this.holdStart = OPENER_IDS.some((id) => !openerBlocked(this.world, PLAYER, id));
    tickFog(this.world); // the base shows through the opener cards

    rig.bounds = { x0: -EDGE_PAD, y0: -EDGE_PAD, x1: this.world.width + EDGE_PAD, y1: this.world.height + EDGE_PAD };
    const v = this.view;
    this.fx = new Fx(v, this.world.biome, (x, y) => this.earshot(x, y));
    this.fx.sourceKind = (id) => this.world.units.get(id)?.kind ?? this.world.buildings.get(id)?.kind ?? null;
    this.entities = new EntityRenderer(
      v,
      this.world,
      this.fx,
      (x, y) => this.tileVisible(x, y),
      (b) => this.buildingShown(b),
      (f) => f === this.fogSide || !this.ctrl.showFog,
      // (a Sniper Team hidden in the woods isn't drawn, though its tile is in sight)
      (u) => this.unitVisible(u)
    );
    this.juice = new CombatJuice(v, {
      world: this.world, entities: this.entities, player: PLAYER, spectator: gameMode.spectator,
      sees: (x, y) => this.seesPoint(x, y),
      earshot: (x, y) => this.earshot(x, y)
    });
    this.mood = new BattleMood({
      player: PLAYER, spectator: gameMode.spectator,
      earshot: (x, y) => this.earshot(x, y),
      sees: (x, y) => this.seesPoint(x, y),
      factionOf: (id) => (this.world.units.get(id) ?? this.world.buildings.get(id))?.faction ?? null,
      // (the siren's rule: a strike that would catch our units or buildings)
      threatened: (x, y, r) => calldownThreatens(this.world, PLAYER, x, y, r),
      // (an anchored Goliath, or the last of the base once the HQ is gone, is the base)
      baseUnit: (id) => {
        const u = this.world.units.get(id);
        return !!u && baseGoliath(this.world, u);
      }
    });
    music.play("battle", this.world.biome);
    const inView = (x: number, y: number) => rig.onScreen(x, y);
    this.radio = new Announcer({
      world: this.world, player: PLAYER, spectator: gameMode.spectator, onScreen: inView,
      caption: (l) => this.hud.radio(l.text, l.tone, l.x, l.y)
    });
    this.voiceHooks = {
      world: this.world, player: PLAYER, spectator: gameMode.spectator,
      inView: (x, y) => this.seesPoint(x, y) && inView(x, y)
    };
    this.wrecks = new WreckRenderer(v, this.world, this.fx, {
      visibleAt: (x, y) => this.tileVisible(x, y),
      pose: (id) => this.entities.pose(id),
      player: PLAYER,
      spectator: gameMode.spectator,
      hint: (msg, x, y, shown) =>
        this.hud.offerHint({ id: "salvage", msg, priority: HINTS.priority.salvage, x, y, onShow: shown })
    });
    this.powerFx = new PowerRenderer(v, this.world, this.fx, {
      player: PLAYER,
      spectator: gameMode.spectator,
      visibleAt: (x, y) => this.tileVisible(x, y),
      earshot: (x, y) => this.earshot(x, y),
      pos: (id) => this.entities.pos(id),
      isShown: (id) => this.entities.isShown(id),
      // (when the game just dropped to 1× for this strike, that note already says it)
      alert: (msg, x, y) => {
        // (its shells landing are the same event: no "Units under attack!" line right after it)
        this.lastAlert = this.simSeconds;
        if (!this.aware.slowedFor("calldown")) this.hud.alert(msg, x, y);
      },
      ping: (x, y) => this.hud.ping(x, y)
    });
    this.objFx = new ObjectiveRenderer(v, this.world, this.fx, {
      player: PLAYER,
      spectator: gameMode.spectator,
      visibleAt: (x, y) => this.tileVisible(x, y),
      ...(uncharted ? { charted: (x: number, y: number) => isExplored(this.world, PLAYER, Math.floor(x), Math.floor(y)) } : {}),
      seesUnit: (u) => this.unitVisible(u),
      earshot: (x, y) => this.earshot(x, y),
      alert: (msg, x, y) => this.hud.alert(msg, x, y),
      notify: (msg, tone) => this.hud.notify(msg, tone),
      ping: (x, y) => this.hud.ping(x, y),
      hint: (msg, x, y) => this.hud.hint(msg, undefined, x, y),
      dropReady: () => !gameMode.spectator && this.ctrl.loadedSelected().length > 0
    });
    this.place = new PlacementView({
      view: v, world: this.world, ctrl: this.ctrl,
      viewCentre: () => this.aware.viewCentre(),
      inView: (x, y) => this.aware.inPlay(x, y, 40),
      glideTo: (x, y) => this.aware.glideTo(x, y),
      hint: (id, msg) => this.command.hint(id, msg),
      handoff: (p) => this.gest.down(p, performance.now())
    });
    this.chronicle = chronicleOf(this.world);
    if (!feed && !gameMode.spectator && !gameMode.op?.tutorial && spotlightOn(safeStorage()))
      this.spot = new Spotlight({
        player: PLAYER,
        onScreen: (x, y) => rig.onScreen(x, y),
        sees: (x, y) => this.seesPoint(x, y),
        reduced: typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches,
        place: (x, y) => placeName(this.chronicle.refs, x, y, PLAYER),
        isHq: (id) => this.world.buildings.get(id)?.kind === "hq"
      });
    this.heroes = new HeroPresenter(v, this.world, {
      player: PLAYER,
      spectator: gameMode.spectator,
      seesPoint: (x, y) => this.seesPoint(x, y),
      seesUnit: (u) => this.unitVisible(u),
      unitPos: (id) => this.entities.pos(id),
      notify: (msg, tone, x, y) => this.hud?.notice(msg, tone, x, y)
    });

    // (the HQ, or under Nomads the anchored Goliath: framing.ts homeBox)
    const focus = gameMode.spectator ? null : homeBox(this.world, PLAYER);
    const c = gameMode.op?.focus ?? (focus ? { x: (focus.x0 + focus.x1) / 2, y: (focus.y0 + focus.y1) / 2 } : { x: this.world.width / 2, y: this.world.height / 2 });
    rig.zoom = this.clampedZoom(DEFAULT_ZOOM);
    rig.centerOn(c.x, c.y);
    this.targetZoom = rig.zoom;

    this.setupInput();
    // the starting harvester gets to work immediately (a duel's openers set every harvester mining already)
    for (const u of this.world.units.values())
      if (u.faction === PLAYER && behaves(u.kind, "harvester") && !gameMode.spectator && !interactive) {
        const f = nearestReachableResource(this.world, u.x, u.y, u.faction);
        if (f) this.ctrl.enqueue({ type: "harvest", faction: PLAYER, unitIds: [u.id], x: f.x + 0.5, y: f.y + 0.5 });
      }
    this.hud = createHud({
      world: this.world,
      ctrl: this.ctrl,
      viewQuad: () => rig.viewQuad(),
      // (the HQ-kill cinematic owns the camera: minimap, toasts, banners and zoom buttons wait)
      centerCamera: (wx, wy) => {
        if (this.finale) return;
        this.cine?.hold();
        this.glide = null;
        rig.centerOn(wx, wy);
      },
      zoomBy: (f) => {
        if (!this.finale) this.zoomBy(f);
      },
      matchSeconds: () => this.simSeconds,
      wrecks: () => this.wrecks.dots(),
      targetChip: () => this.powerUi?.chip() ?? null,
      calldowns: () => this.powerFx.rings(),
      minimapOverlay: (ctx, k) => this.objFx.minimap(ctx, k),
      strategies: interactive
        ? null
        : feed
        ? feed.labels
        : this.blueAi
        ? {
            blue: `${this.blueAi.strategy.label}${openers.blue ? ` · ${OPENERS[openers.blue].name}` : ""}`,
            red: !this.ai ? "les vagues" : `${this.ai.strategy.label}${openers.red ? ` · ${OPENERS[openers.red].name}` : ""}`
          }
        : null,
      enemy: { strategy: this.ai?.strategy.label ?? "Survie", difficulty: gameMode.difficulty },
      cardNote: (k) => this.command?.cardNote(k) ?? null,
      busy: () => this.holdStart || !!this.finale,
      uncharted,
      ...(interactive && feed?.duel ? { duel: feed.duel } : {})
    });

    this.aware = new Awareness({
      rig, canvas: this.stage.canvas, world: this.world, player: PLAYER, spectator: gameMode.spectator,
      hud: this.hud, radio: this.radio,
      sees: (x, y) => this.seesPoint(x, y),
      seesUnit: (u) => this.unitVisible(u),
      cinematic: () => !!this.finale,
      pulse: (x, y, col) => this.fx.pulse(x, y, col, 1.4),
      // (a duel: both phones at 1×, the feed's slack trim aside)
      fixedSpeed: interactive,
      calm: !!gameMode.op?.tutorial,
      took: () => this.cine?.hold()
    });
    if (gameMode.spectator) {
      // AI vs AI: the cinematic camera follows the action (on unless switched off before)
      this.cine = new Director(this.world);
      try {
        this.cineOn = localStorage.getItem(CINE_KEY) !== "0";
      } catch {
        /* storage blocked: on */
      }
      const cineUi = mountCineToggle(document.getElementById("hud")!, () => this.toggleCine());
      this.cineUi = cineUi;
      this.teardown.push(() => cineUi.destroy());
    }
    this.command = new CommandUi({
      root: document.getElementById("hud")!, world: this.world, ctrl: this.ctrl, spectator: gameMode.spectator,
      glideTo: (x, y) => this.aware.glideTo(x, y),
      tip: (msg, ms) => this.hud.hint(msg, ms),
      offerHint: (h) => this.hud.offerHint(h)
    });
    this.objPill = createObjectivePill(this.world, PLAYER, gameMode.spectator);
    const powerUi = createPowerPanel({
      world: this.world,
      ctrl: this.ctrl,
      notify: (msg, tone) => this.hud.notify(msg, tone),
      // (long-press details run longer than a 2-line ticker toast)
      info: (msg) => this.hud.hint(msg, 6500),
      offerHint: (h) => this.hud.offerHint(h),
      viewCentre: () => rig.ground(rig.width / 2, rig.height / 2)
    });
    this.powerUi = powerUi;
    this.teardown.push(() => {
      this.objPill?.destroy();
      this.objFx.destroy();
      this.command.destroy();
      this.place.destroy();
      this.aware.destroy();
      powerUi.destroy();
      this.powerFx.destroy();
      this.hud.destroy();
      this.radio.destroy();
    });
    // Daily Op / mutators banner (with opener cards up it waits for the pick: the cards would hide it)
    if (!this.holdStart) window.setTimeout(() => announceRules(this.world), 1200);
    if (this.world.ops)
      this.ops = new OpsPresenter(this.world, {
        notify: (m, t, x, y) => this.hud.notice(m, t, x, y),
        // (the campaign's opening cards hold the clock: ui/cine.ts)
        hold: (on) => (this.ctrl.paused = on),
        spectator: gameMode.spectator || !!this.feed
      });
    if (this.world.ops && gameMode.op?.tutorial && !gameMode.spectator) {
      const tut = new TutorialView({
        world: this.world,
        ctrl: this.ctrl,
        rig,
        hudRoot: document.getElementById("hud")!,
        belle: BELLE_EPOQUE,
        glideTo: (x, y) => this.aware.glideTo(x, y),
        zoomTo: (z) => {
          this.targetZoom = this.clampedZoom(z);
          this.zoomAnchor = null;
        },
        surfaceAt: (x, y) => this.terrain.surfaceAt(x, y),
        screenOf: (id) => {
          const p = this.entities.pos(id);
          if (!p || !this.entities.isShown(id)) return null;
          const s = rig.project(p.x, p.y, (p.h + p.top) / 2);
          return s.behind ? null : s;
        },
        playCentre: () => this.aware.playCentre(),
        inPlay: (x, y, m) => this.aware.inPlay(x, y, m),
        targeting: () => this.powerUi?.targeting ?? null,
        say: (text) => this.radio.push({ key: `tuto:${text}`, text, priority: 1, tone: "info", caption: false }),
        pulse: (x, y, col, size) => this.fx.pulse(x, y, col, size),
        leave: () => fullscreen.reload()
      });
      this.tutorial = tut;
      this.teardown.push(() => tut.destroy());
    }
    if (focus && !gameMode.op) this.frameStart(); // an op opens on its own focus point
    if (this.holdStart) {
      const picker = showOpenerPicker({
        context: `${uncharted ? "Inexplorée" : mapById(gameMode.mapId).name} · contre ${this.ai ? `IA ${this.ai.strategy.label}` : "les vagues"} (${DIFFICULTY[gameMode.difficulty].label})`,
        onPick: (id) => this.startWithOpener(id),
        blocked: (id) => openerBlocked(this.world, PLAYER, id),
        // (a nation's cards name its own kinds: Fourgons, Jamais-Contente…)
        nation: nationOf(this.world, PLAYER),
        kindFor: (k) => nationKind(this.world, PLAYER, k),
        enemyNation: nationOf(this.world, PLAYER === "blue" ? "red" : "blue"),
        // islands are taken by troops and defended from the air: the Airpad matters most there
        // (not on an Uncharted map: that would tell what it is)
        recommended: (id) => (!uncharted && mapById(gameMode.mapId).islands && id === "airwing" ? "Idéal ici : Chalais-Meudon pour plus de Montgolfières" : null)
      });
      this.teardown.push(() => picker.destroy());
    }

    // debug/testing handle (harmless in production)
    (window as unknown as Record<string, unknown>).__bd = {
      world: this.world,
      ctrl: this.ctrl,
      /** The side this page commands (red under `?side=red`, or a sound duel's red phone). */
      get player() {
        return PLAYER;
      },
      cam: rig,
      scene: this,
      three: { stage: this.stage, terrain: this.terrain, THREE },
      announce,
      music,
      radio: this.radio,
      /** The recorded announcer's clips (Panache): fetch and play counts. */
      voice: voicePack,
      voices,
      aware: this.aware,
      place: this.place,
      command: this.command,
      /** L'Instruction's director (null outside it). */
      tutorial: this.tutorial,
      /** Tile point → CSS px on screen (for tests and tools). */
      toScreen: (x: number, y: number, h = 0) => rig.project(x, y, h),
      /** Where an entity is drawn on screen (its body), for tests and tools. */
      screenOf: (id: number) => {
        const p = this.entities.pos(id);
        return p ? rig.project(p.x, p.y, (p.h + p.top) / 2) : null;
      },
      canPlace: (tx: number, ty: number) =>
        canPlaceBuilding(this.world, PLAYER, this.ctrl.placing ?? "fab-plant", tx, ty)
    };

    feed?.attach(this);
    this.stage.precompile();
    this.lastFrame = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  // ------------------------------------------------- fed matches (viewer) --

  /** Show the whole battlefield (null), or the fog of war as `side` saw it. */
  setFog(side: Faction | null): void {
    this.ctrl.showFog = side !== null;
    if (side) {
      this.fogSide = side;
      this.terrain.setFogSide(side);
    }
  }

  /** Whose eyes the view is looking through (null: the fog is off). */
  fogShown(): Faction | null {
    return this.ctrl.showFog ? this.fogSide : null;
  }

  /** The tick the fed match has reached. */
  get tick(): number {
    return this.world.tick;
  }

  /**
   * Jump a fed match to `tick`: back to the latest keyframe before it, then
   * forward with rendering (and sound) off, as fast as the sim goes.
   */
  seek(tick: number): void {
    const feed = this.feed;
    if (!feed || this.interactive) return; // (a duel can't be rewound or skipped)
    const target = Math.max(0, Math.floor(tick));
    if (target < this.world.tick) {
      const kf = feed.keyframe(target);
      if (!kf) return;
      Object.assign(this.world, structuredClone(kf));
      this.finale = null;
      this.finaleAt = null;
      this.ended = false;
    }
    while (this.world.tick < target && !this.world.winner) {
      const cmds = feed.commands(this.world.tick);
      if (!cmds) break;
      step(this.world, cmds);
      // (a seek to the end steps the deciding tick itself: the finale still names what decided it)
      for (const ev of this.world.fx) {
        this.chronicle.onFx(ev);
        this.noteDecider(ev);
      }
      // (the cinematic camera warms up on what it skipped, so it knows where the fighting is)
      this.cine?.events(this.world.fx, this.world.tick / TICK_RATE);
      this.chronicle.tick();
      feed.afterTick(this.world, true);
    }
    this.world.fx = [];
    this.simSeconds = this.world.tick / TICK_RATE;
    this.snapshotPrev();
  }

  /**
   * A fed match's cut (a highlight reel, ui/reel.ts): the camera straight
   * onto (x, y), or where the fighting is hottest when no spot is given
   * (the director's pick, else `side`'s army), and the director carries on
   * from there.
   */
  cutTo(x: number | null, y: number | null, side: Faction = "blue", zoom = 46): void {
    const rig = this.stage.rig;
    let at = x !== null && y !== null ? { x, y } : null;
    if (!at && this.cine) at = this.cine.subjects()[0] ?? this.cine.army(side);
    if (!at) at = { x: this.world.width / 2, y: this.world.height / 2 };
    rig.zoom = this.clampedZoom(zoom);
    this.targetZoom = rig.zoom;
    this.zoomAnchor = null;
    this.glide = null;
    const c = this.aware.playCentre();
    rig.placeAt(at.x, at.y, c.x, c.y);
    this.cine?.reset({ x: at.x, y: at.y, zoom: rig.zoom });
  }

  /** A commander's radio line: in the ticker, read out by the announcer. */
  commanderRadio(side: Faction, text: string): void {
    this.radio.push({ key: `commander-${side}`, text: `${side === "blue" ? "Bleu" : "Rouge"} : ${text}`, priority: 1, tone: "info", caption: true });
  }

  /** A line in the alert ticker. */
  alert(msg: string): void {
    this.hud.alert(msg, this.world.width / 2, this.world.height / 2);
  }

  /** The window changed size or orientation. */
  resize(): void {
    this.stage.resize();
    this.clampZoom();
  }

  /** Open on the player's HQ, home field and factory site, framed clear of the HUD. */
  private frameStart(): void {
    const box = startBox(this.world, PLAYER);
    if (!box) return;
    const rig = this.stage.rig;
    const ins = hudInsets();
    const vw = rig.width;
    const vh = rig.height;
    // (the tilted view shortens the box's north-south extent on screen)
    const flat = { ...box, y1: box.y0 + (box.y1 - box.y0) * 0.85 };
    const fit = Math.min(48, Math.max(26, fitZoom(flat, vw, vh, ins, 1)));
    rig.zoom = this.clampedZoom(fit);
    this.targetZoom = rig.zoom;
    const sx = ins.left + (vw - ins.left - ins.right) / 2;
    const sy = ins.top + (vh - ins.top - ins.bottom) / 2;
    rig.placeAt((box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2, sx, sy);
  }

  /** The player picked an opener: both sides get theirs (blue's first, as in a duel) and the clock starts. */
  /** How opener lines name things for this match: our nation's kinds, the enemy's workers (ui/openers.ts nationText). */
  private openerWords(): Words {
    const foe = nationOf(this.world, PLAYER === "blue" ? "red" : "blue");
    return {
      nation: nationOf(this.world, PLAYER),
      kindFor: (k) => nationKind(this.world, PLAYER, k),
      ...(foe !== "classique" ? { enemyWorker: { nation: foe, kind: ROLES[foe].worker } } : {})
    };
  }

  private startWithOpener(id: OpenerId): void {
    if (!this.holdStart) return;
    const picks: Partial<Record<Faction, OpenerId>> = { [PLAYER]: id };
    // (the rules alone decide what's allowed, so the AI's pick is the same before or after ours lands)
    const theirs = this.ai && allowedOpener(this.world, ENEMY, pickAiOpener(this.ai.strategy.name, this.world.seed, ENEMY));
    if (theirs) picks[ENEMY] = theirs;
    const mine = applyOpenersCanonical(this.world, picks)[PLAYER]!;
    this.recorder?.opened(picks);
    this.holdStart = false;
    // roll-out flourish on everything that just arrived
    const b = mine.buildingId !== null ? this.world.buildings.get(mine.buildingId) : null;
    if (b) {
      const c = buildingCenter(b);
      this.fx.pulse(c.x, c.y, 0x7ef29b, BUILDINGS[b.kind].size);
    }
    for (const uid of mine.unitIds) {
      const u = this.world.units.get(uid);
      if (u) this.fx.pulse(u.x, u.y, 0x7ec1ff, 0.8);
    }
    sfx.play("build");
    const o = OPENERS[id];
    announce({ key: `opener-${id}`, text: `${o.name} !`, sub: nationText(o.rollout, id, this.openerWords()), tone: "good", priority: 1 });
    announceRules(this.world); // (queued behind the roll-out)
  }

  /** Nudge the smooth-zoom target (zoom buttons, +/- keys, wheel). */
  zoomBy(factor: number, anchorX?: number, anchorY?: number): void {
    this.cine?.hold(); // (the player zooming takes the camera from the director for a while)
    this.targetZoom = this.clampedZoom(this.targetZoom * factor);
    this.zoomAnchor = anchorX !== undefined && anchorY !== undefined ? { x: anchorX, y: anchorY } : null;
  }

  /** Volume for a sound at tile point (x, y): full on screen, fading off it. */
  private earshot(x: number, y: number): number {
    const v = this.viewBox;
    const dx = Math.max(v.x0 - x, 0, x - v.x1);
    const dy = Math.max(v.y0 - y, 0, y - v.y1);
    const d = Math.hypot(dx, dy);
    const zoomOut = Math.min(1.2, Math.max(0.5, this.stage.rig.zoom / DEFAULT_ZOOM));
    return Math.max(0, 1 - d / 8) * zoomOut;
  }

  /** AI vs AI: switch the cinematic camera on or off (the 🎥 button, C). */
  toggleCine(): void {
    if (!this.cine) return;
    this.cineOn = !this.cineOn;
    try {
      localStorage.setItem(CINE_KEY, this.cineOn ? "1" : "0");
    } catch {
      /* ignore */
    }
    if (this.cineOn) this.cine.reset({ ...this.aware.viewCentre(), zoom: this.stage.rig.zoom });
    this.cineUi?.set(this.cineOn, false);
    sfx.play("click", 0.5);
    this.hud.notify(this.cineOn ? "🎥 Caméra cinématique activée" : "🎥 Caméra cinématique désactivée — à toi la caméra");
  }

  /**
   * AI vs AI with the cinematic camera on: put the camera where the director
   * says. False when it isn't driving this frame (off, the player has the
   * camera for a moment, or the finale owns it).
   */
  private directCamera(delta: number): boolean {
    const cine = this.cine;
    if (!cine) return false;
    this.cineUi?.set(this.cineOn, cine.held);
    if (!this.cineOn || this.finale) return false;
    const rig = this.stage.rig;
    const shot = cine.update(delta / 1000, { ...this.aware.viewCentre(), zoom: rig.zoom });
    this.cineUi?.set(true, !shot);
    if (!shot) return false;
    rig.zoom = this.clampedZoom(shot.zoom);
    this.targetZoom = rig.zoom;
    this.zoomAnchor = null;
    this.glide = null;
    const c = this.aware.playCentre();
    rig.placeAt(shot.x, shot.y, c.x, c.y);
    return true;
  }

  private updateCamera(delta: number): void {
    const rig = this.stage.rig;
    if (this.directCamera(delta)) return;
    if (Math.abs(rig.zoom - this.targetZoom) > 0.01) {
      const t = 1 - Math.pow(0.0025, delta / 1000);
      const next = rig.zoom + (this.targetZoom - rig.zoom) * t;
      const a = this.zoomAnchor ?? { x: rig.width / 2, y: rig.height / 2 };
      rig.zoomAround(this.clampedZoom(next), a.x, a.y);
    }
    if (this.finale) return; // the cinematic owns the camera (its pan and push-in): no keys, no momentum
    // keyboard panning (arrows / WASD), speed in CSS px/s
    const pan = (700 * delta) / 1000;
    let kx = 0;
    let ky = 0;
    const k = this.keys;
    if (k.has("ArrowLeft") || k.has("KeyA")) kx -= 1;
    if (k.has("ArrowRight") || k.has("KeyD")) kx += 1;
    if (k.has("ArrowUp") || k.has("KeyW")) ky -= 1;
    if (k.has("ArrowDown") || k.has("KeyS")) ky += 1;
    if (kx !== 0 || ky !== 0) {
      this.cine?.hold();
      rig.pan(-kx * pan, -ky * pan);
      this.glide = null;
    }
    if (this.glide) {
      rig.pan(this.glide.x, this.glide.y);
      const friction = Math.pow(0.9, delta / (1000 / 60));
      this.glide.x *= friction;
      this.glide.y *= friction;
      if (Math.hypot(this.glide.x, this.glide.y) < 0.4) this.glide = null;
    }
  }

  private frame = (now: number): void => {
    this.raf = requestAnimationFrame(this.frame);
    const raw = now - this.lastFrame;
    this.lastFrame = now;
    // a backgrounded tab resumes without a burst of catch-up ticks
    if (raw < 1000) this.stage.adapt(raw);
    this.update(Math.min(250, raw > 0 ? raw : 16));
  };

  /** Advance one frame of `delta` real ms; `render` false skips drawing (fast-forwarding tools). */
  update(delta: number, render = true): void {
    this.gest.tick(performance.now());
    this.updateCamera(delta);

    // (the Instruction's freeze-frames: the lesson waits on the player's tap)
    if (!this.ctrl.paused && !this.ended && !this.holdStart && !this.tutorial?.hold) {
      // game speed (1–4×; a duel's slack trim; a highlight reel's pace), at most AWARE.maxTicksPerFrame ticks per frame,
      // slowed for a Temps fort (single player only: the sim takes ticks, not time, so it plays the same match slower)
      const speed = this.interactive ? this.feed?.speed?.() ?? 1 : this.feed?.speed ? this.feed.speed() : this.aware.value * (this.spot?.timeScale ?? 1);
      const plan = planTicks(this.acc, delta, speed);
      this.acc = plan.acc;
      for (let i = 0; i < plan.ticks; i++) {
        // decided mid-frame: the winning tick's events were handled once, don't replay them
        if (this.world.winner) break;
        const fed = this.feed ? this.feed.commands(this.world.tick) : null;
        if (this.feed && !fed) {
          // (a duel stalls on the friend's turn: hold the pose, and no burst of catch-up ticks after)
          if (this.interactive) this.acc = TICK_MS * 0.999;
          break; // (a live battle: the next round isn't played yet)
        }
        this.snapshotPrev();
        // our orders (a spectator's: blue's commander; a duel's: drained by its feed) and the enemy commander's, stepped blue's first
        const mine = this.blueAi ? tickAi(this.world, "blue", this.blueAi) : this.interactive ? [] : this.ctrl.drainCommands();
        const theirs = this.ai ? tickAi(this.world, ENEMY, this.ai) : []; // (Last Stand: the waves have no commander)
        this.recorder?.step(this.world.tick, PLAYER === "blue" ? mine : theirs, PLAYER === "blue" ? theirs : mine);
        step(this.world, fed ?? composeTick(PLAYER, mine, theirs));
        this.recorder?.stepped(this.world);
        this.simSeconds += 1 / TICK_RATE;
        this.afterTick();
        this.feed?.afterTick(this.world, false);
      }
    }
    this.ctrl.prune();
    this.feed?.frame(delta);
    const alpha = this.ctrl.paused ? 1 : this.acc / TICK_MS;
    this.finale?.update(delta);
    const moment = this.spot?.update(this.ctrl.paused || this.ended || this.holdStart ? 0 : delta, this.simSeconds, !!this.world.winner);
    if (moment) this.playSpot(moment);
    const slow = Math.min(this.finale?.timeScale ?? 1, this.spot?.timeScale ?? 1);
    const rig = this.stage.rig;
    rig.update(delta);
    this.viewBox = rig.viewRect();
    const v = this.view;
    v.ground.clear();
    v.over.clear();
    v.top.clear();
    const fxDt = this.ctrl.paused ? 0 : delta * slow;
    this.view.tweens.update(delta * slow);
    this.terrain.update(delta * slow, this.ctrl.showFog);
    this.entities.sync(alpha, this.prev, fxDt);
    this.wrecks.sync(fxDt);
    this.powerFx.sync(fxDt, alpha, this.powerUi?.preview() ?? null);
    this.objFx.sync(fxDt, alpha);
    this.fx.projectiles(this.world.projectiles, alpha, this.prev);
    this.fx.update(fxDt);
    v.particles.update(delta * slow);
    this.juice.update(fxDt);
    this.place.update(delta);
    this.drawWorldMarks();
    if (render) {
      v.ground.flush();
      v.over.flush();
      v.top.flush();
      this.stage.render();
      this.drawScreen();
      // (a highlight reel films the frame here, while the 3D canvas still holds it)
      this.feed?.rendered?.(this.stage.renderer.domElement, this.stage.screen.canvas);
    }
    this.hud.update(delta);
    if (this.ctrl.tip) {
      // a note on the order just given ("Condor full: unload it first")
      this.hud.notify(this.ctrl.tip);
      this.ctrl.tip = null;
    }
    this.command.update();
    if (!this.ctrl.paused) this.tutorial?.update(delta);
    this.aware.update(delta, this.ctrl.paused);
    voices.watchSelection(this.ctrl.selectedUnits, this.world);
    this.radio.update(delta, this.ctrl.paused);
    music.update({
      intensity: this.mood.update(delta / 1000, this.simSeconds),
      alarm: this.mood.alarm(this.simSeconds),
      paused: this.ctrl.paused
    });
    this.powerUi?.update();
    this.objPill?.update();

    if (this.world.winner && !this.ended) {
      this.ended = true;
      const won = this.world.winner === PLAYER;
      // Last Stand always ends in defeat; a new record still gets the fanfare
      const run = this.survival && !gameMode.spectator && !this.world.ops ? finishRun(this.world, this.world.mapId, this.survival.difficulty) : null;
      this.chronicle.finish();
      this.keepMatch();
      // XP, medals, stars (spectators: no-op; a duel keeps its own record, src/versus/records.ts)
      if (!this.interactive) settleCareer(this.world, PLAYER);
      this.playFinale(() => {
        // at the flash the score resolves into a fanfare / lament; the SFX jingle covers music-off
        // (Robot Love: a draw resolves on its own sweet sting; its chime has already rung for music-off)
        const draw = this.world.winner === "draw";
        const outcome = draw ? "draw" : finaleOutcome({ won, newRecord: !!run?.isNew, spectator: gameMode.spectator, survival: !!this.survival });
        // (a duel's draw is Robot Love's only when two Goliaths fell in love: both resigning has no love sting, SOUND-DUEL.md "Resign")
        const played = this.interactive ? music.finale(outcome, { love: !!this.world.love }) : music.finale(outcome);
        if (!played && !gameMode.spectator && outcome !== "draw") sfx.play(outcome);
      });
    }
  }

  /**
   * The decided match into the Archives (archive.ts), with its highlight
   * reel's moments from the chronicle, and the report's « ▶ Revoir les temps
   * forts » (ui/reel-entry.ts): a single-player skirmish's own record, or a
   * duel's (its feed's). Replays and AI vs AI aren't the player's matches.
   * Never in the way of the end: a failure is only logged.
   */
  private keepMatch(): void {
    const w = this.world;
    const winner = w.winner;
    if (!winner || this.aborted || (!this.recorder && !this.interactive)) return;
    try {
      const at = winner === "draw" && w.love ? { x: w.love.x, y: w.love.y } : this.finaleAt;
      const reel = reelMoments(this.chronicle, PLAYER, { tick: w.tick, winner, ...(at ? { x: at.x, y: at.y } : {}) });
      const played: PlayedInfo = {
        pov: PLAYER,
        kind: this.interactive ? "duel" : gameMode.daily ? "quotidienne" : "escarmouche",
        result: winner === "draw" ? "draw" : winner === PLAYER ? "win" : "loss",
        against: this.interactive ? this.feed?.opponent ?? "ton ami" : `IA ${this.ai?.strategy.label ?? ""} (${DIFFICULTY[gameMode.difficulty].label})`
      };
      const rec = this.recorder ? this.recorder.record(w, played, reel) : this.feed?.saveable?.() ?? null;
      if (!rec) return;
      if (this.recorder) rec.seats[ENEMY] = { player: played.against };
      else Object.assign(rec, { played, reel });
      const saved = archiveMatch(archives(), rec);
      const duel = this.interactive ? this.feed?.duel : undefined;
      addReportSection(reelSection({ record: rec, saved, leave: duel ? () => duel.menu() : () => fullscreen.reload() }));
    } catch (e) {
      console.warn("archives:", e);
    }
  }

  /**
   * End a duel with no result (SOUND-DUEL.md "Hash trail and the end of the
   * match", "Leaving"): the two worlds drifted apart, the friend left, or this
   * phone left ("Leave (no result)"). No finale and no career; selection and
   * placement go, and the end screen says why, with "Copy debug info" when
   * `info` is given (a desync). A finale or report already up gives way: an
   * end check that fails after the result was shown is no contest after all.
   * The score settles on its quiet coda as at a finale's flash, with no sting
   * and no SFX jingle (nothing was won or lost): without it the battle score
   * plays on under the end screen at the intensity the match stopped at, its
   * mood frozen with the sim clock.
   */
  abort(reason: AbortReason, info?: string): void {
    if (this.aborted) return;
    this.aborted = reason;
    this.ended = true;
    this.finale = null;
    // (a finale past its flash has resolved the score already: this keeps that)
    music.finale("draw", { love: false });
    this.glide = null;
    this.gest.reset();
    this.boxRect = null;
    this.ctrl.clearSelection();
    this.ctrl.placing = null;
    this.ctrl.locked = true;
    this.powerUi?.cancel();
    const opts: EndOpts = { head: ABORT_HEAD[reason] };
    if (info !== undefined)
      opts.actions = [
        {
          id: "copy-debug",
          label: "Copier infos de débogage",
          cls: "alt",
          on: () => {
            const ok = () => this.hud.notify("Infos de débogage copiées", "good");
            const no = () => this.hud.notify("Copie impossible : ce navigateur ne l'autorise pas", "bad");
            try {
              void navigator.clipboard.writeText(info).then(ok, no);
            } catch {
              no();
            }
          }
        }
      ];
    this.hud.showEnd(null, opts);
  }

  /** How a duel ended with no result (null: it hasn't, or it was decided). */
  get abortReason(): AbortReason | null {
    return this.aborted;
  }

  /** The match is over here: decided (its finale may still be playing) or aborted. */
  get over(): boolean {
    return this.ended;
  }

  /** Fast-forward helper for tools: `n` frames of `ms` each, drawing only the last (none with `draw` false: tools/duel-smoke.mjs steps two pages that share a software renderer). */
  step(ms = 100, n = 1, draw = true): void {
    for (let i = 0; i < n; i++) this.update(ms, draw && i === n - 1);
  }

  /**
   * The kill that decided it (an HQ, or a side's last Goliath): slow
   * motion, a camera glide onto the wreck, rolling blasts, a white flash
   * with the result line, then the after-action report. Robot Love: the
   * camera glides onto the two Goliaths as they meet, hearts, and a draw.
   */
  private playFinale(stinger: () => void): void {
    const winner = this.world.winner!;
    // an op that ended on its objective has no HQ wreck: look where it was decided, skip the blasts
    const opEnd = this.world.ops?.result;
    const love = winner === "draw" ? this.world.love ?? null : null;
    if (love) this.entities.love(love.ids, love.x, love.y);
    const at = (love ? { x: love.x, y: love.y, size: 2, cause: "love" as const } : null) ??
      (opEnd?.byGoal ? { x: opEnd.x, y: opEnd.y, size: 3, cause: "hq" as const } : null) ??
      this.finaleAt ?? { x: this.world.width / 2, y: this.world.height / 2, size: 3, cause: "hq" as const };
    const spec = gameMode.spectator;
    this.glide = null;
    this.gest.reset(); // a drag or pinch in progress lets go of the camera
    this.boxRect = null;
    this.ctrl.clearSelection();
    this.ctrl.placing = null;
    const rig = this.stage.rig;
    // (Robot Love pushes in close: it's their eyes and the hearts you want to see)
    const zoom = love ? Math.min(MAX_ZOOM, Math.max(rig.zoom * 1.5, 72)) : finaleZoom(rig.zoom, DEFAULT_ZOOM);
    const free = freeAreaOffset();
    this.finale = new Finale({
      view: this.view,
      fx: this.fx,
      x: at.x,
      y: at.y,
      size: at.size,
      // (an op won on its goal, Robot Love or a resign: nothing blew up)
      blasts: !opEnd?.byGoal && !love && at.cause !== "resign",
      love: !!love,
      screenX: rig.width / 2 + free.x,
      screenY: rig.height / 2 + free.y,
      onFlash: () => {
        stinger();
        announce(
          this.ops && !love
            ? this.ops.endAnnouncement()
            : this.survival && !love
            ? { key: "base-overrun", text: "Base submergée", sub: "Le GQG est tombé", tone: "bad", priority: 0, x: at.x, y: at.y }
            : finaleBanner({ cause: at.cause, winner, player: PLAYER, spectator: spec, x: at.x, y: at.y, nations: { blue: nationOf(this.world, "blue"), red: nationOf(this.world, "red") } })
        );
      },
      onDone: () => {
        this.finale = null;
        // (a campaign mission: its closing card first, game/ops.ts)
        if (this.feed?.ended?.(winner)) return;
        if (this.ops && !love) this.ops.outro(() => this.hud.showEnd(winner));
        else this.hud.showEnd(winner);
      }
    });
    this.zoomBy(zoom / this.targetZoom);
  }

  /**
   * A Temps fort (spotlight.ts): its banner, and when it's on screen the
   * jolt and a push-in anchored on the spot (the slow motion is the time
   * scale update() reads). The camera never leaves what the player is
   * looking at: nothing here pans.
   */
  private playSpot(s: Spot): void {
    if (s.banner) announce(s.banner);
    const rig = this.stage.rig;
    if (s.shake) rig.shake(SPOT_SHAKE.ms, SPOT_SHAKE.intensity);
    if (s.nudge && !this.ctrl.placing) {
      const p = rig.project(s.x, s.y);
      if (!p.behind) this.zoomBy(SPOTLIGHT.nudge, p.x, p.y);
    }
  }

  /**
   * Skip the finale still playing and show the end screen now (a duel's
   * "Resign and leave": the player asked to go). The result banner and its
   * music come first, as at the flash.
   */
  skipFinale(): void {
    const f = this.finale;
    const winner = this.world.winner;
    if (!f || !winner || this.aborted) return;
    f.update(Math.max(FINALE.doneAt, LOVE_FINALE.doneAt));
  }

  // ------------------------------------------------------------- sim glue --

  private snapshotPrev(): void {
    this.prev.clear();
    for (const u of this.world.units.values()) this.prev.set(u.id, { x: u.x, y: u.y });
    for (const p of this.world.projectiles) this.prev.set(p.id, { x: p.x, y: p.y });
  }

  /** Is the entity (or point) something the local player may see? */
  private seesPoint(x: number, y: number): boolean {
    return !this.ctrl.showFog || this.tileVisible(x, y);
  }

  private afterTick(): void {
    // first: game-speed safety may drop to 1× and say why, so the alerts below can stay quiet
    this.aware.events(this.world.fx, this.simSeconds);
    this.cine?.events(this.world.fx, this.simSeconds);
    for (const ev of this.world.fx) {
      this.handleFx(ev);
      this.wrecks.onFx(ev);
      this.entities.onFx(ev);
      this.powerFx.onFx(ev);
      this.objFx.onFx(ev);
    }
    this.juice.events(this.world.fx);
    this.spot?.events(this.world.fx, this.simSeconds);
    this.mood.events(this.world.fx, this.simSeconds);
    this.radio.events(this.world.fx, this.simSeconds);
    voices.events(this.world.fx, this.voiceHooks);
    this.command.events(this.world.fx, this.simSeconds);
    this.ops?.tick();
    this.tutorial?.afterTick();
    this.chronicle.tick();
    this.heroes.flush();
    const fb = this.ctrl.lastFeedback;
    if (fb) {
      this.ctrl.lastFeedback = null;
      const tint =
        fb.kind === "attack" ? 0xff5a4a
        : fb.kind === "rally" || fb.kind === "drop" ? 0xffe066
        : fb.kind === "board" ? 0x7ec1ff
        : 0x7ef29b;
      this.fx.marker(fb.x, fb.y, tint);
      sfx.play("click", 0.6);
      // a short buzz under the thumb: the order went (a double one for a patrol; none on iOS Safari, which has no vibrate)
      if (typeof navigator.vibrate === "function") navigator.vibrate(fb.route === "patrol" ? [12, 60, 12] : fb.route ? 18 : fb.kind === "attack" ? 14 : 8);
      voices.order(fb.kind, this.ctrl.selectedUnits, this.world);
    }
  }

  /** A point at height `lift` above the ground (or at flying height). */
  private at(x: number, y: number, air: boolean, lift = 0.25): P3 {
    const g = this.terrain.surfaceAt(x, y);
    return { x, y, h: air ? g * 0.3 + AIR_H : g + lift };
  }

  /**
   * The finale looks at the death that decided the match: the loser's HQ, or its last Goliath (in one
   * tick unit deaths come before building deaths, and an HQ that falls with them is what decides it).
   */
  private noteDecider(ev: FxEvent): void {
    const w0 = this.world;
    if (ev.type === "death" && w0.winner && w0.winner !== "draw" && ev.faction !== w0.winner) {
      if (ev.buildingKind === "hq") this.finaleAt = { x: ev.x, y: ev.y, size: BUILDINGS.hq.size, cause: "hq" };
      else if (ev.unitKind === "goliath" && this.finaleAt?.cause !== "hq") this.finaleAt = { x: ev.x, y: ev.y, size: 2, cause: "goliath" };
    }
  }

  private handleFx(ev: FxEvent): void {
    this.chronicle.onFx(ev);
    this.heroes.handleFx(ev);
    this.noteDecider(ev);
    if (this.survival?.handleFx(ev)) return;
    const w = this.world;
    switch (ev.type) {
      case "resign": {
        // (a sound duel) the finale looks at the side that gave up: its HQ, else the middle of its home box
        if (this.finaleAt?.cause === "resign") break; // (both at once: the first one's)
        const hq = hqOf(w, ev.faction);
        const box = hq ? null : homeBox(w, ev.faction);
        const c = hq ? buildingCenter(hq) : box ? { x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2 } : { x: w.width / 2, y: w.height / 2 };
        this.finaleAt = { x: c.x, y: c.y, size: hq ? BUILDINGS.hq.size : 2, cause: "resign" };
        break;
      }
      case "shot": {
        // (the nations' new shells are drawn as the Mortar's; render/fx.ts voices them by their gun: the Branly's zap-boum, the 280's boom)
        if (ev.fx === "arc-shell" || ev.fx === "heavy-shell") ev = { ...ev, fx: "shell" };
        const src = w.units.get(ev.sourceId) ?? w.buildings.get(ev.sourceId);
        // (a Goliath is always seen: its guns flash even in the fog)
        const always = !!src && "goliath" in src && !!src.goliath;
        if (!always && !this.seesPoint(ev.x, ev.y) && !this.seesPoint(ev.tx, ev.ty)) return;
        const faction = src?.faction ?? PLAYER;
        this.entities.fired(ev.sourceId, Math.atan2(ev.tx - ev.x, -(ev.ty - ev.y)), ev.fx);
        const from = this.entities.muzzle(ev.sourceId, ev.fx) ?? this.at(ev.x, ev.y, ev.fromAir);
        const jitter = () => (Math.random() - 0.5) * 0.22;
        const to = this.at(ev.tx + jitter(), ev.ty + jitter(), ev.air, 0.22);
        this.fx.shot(ev, from, to, faction);
        break;
      }
      case "explosion": {
        // a Goliath's death: no hull fireball, its reactor goes and it topples (render/goliath.ts), seen through any fog
        const goliath = ev.kind === "unit" ? this.goliathDeathAt(ev.x, ev.y) : null;
        if (goliath) {
          const p = this.entities.pos(goliath);
          this.fx.goliathBlast(p ? { x: p.x, y: p.y, h: p.h + p.top * 0.6 } : this.at(ev.x, ev.y, false, 1.6));
          break;
        }
        if (ev.kind === "building" ? !this.buildingBlastShown(ev.x, ev.y, ev.size) : !this.seesPoint(ev.x, ev.y)) return;
        this.fx.explosion(ev, this.at(ev.x, ev.y, ev.air, ev.kind === "building" ? 0.4 : 0.2));
        break;
      }
      case "heal": {
        if (!this.seesPoint(ev.x, ev.y)) return;
        // (no beam into the fog, or onto a Sniper Team hidden in the woods: it would mark the spot)
        const target = w.units.get(ev.targetId);
        if (target ? !this.unitVisible(target) : !this.seesPoint(ev.tx, ev.ty)) return;
        const from = this.entities.pos(ev.sourceId);
        const to = this.entities.pos(ev.targetId);
        if (from && to) this.fx.heal({ x: from.x, y: from.y, h: from.h - 0.05 }, { x: to.x, y: to.y, h: (to.h + to.top) / 2 });
        break;
      }
      case "built": {
        if (ev.faction !== PLAYER || gameMode.spectator) return;
        const b = w.buildings.get(ev.id);
        const u = w.units.get(ev.id);
        if (b) {
          sfx.play("build");
          const c = buildingCenter(b);
          this.fx.pulse(c.x, c.y, 0x7ef29b, BUILDINGS[b.kind].size);
        } else if (u) {
          if (!voices.active) sfx.play("ready", 0.5); // else the unit reports in (voices.ts)
          this.fx.pulse(u.x, u.y, 0x7ec1ff, 0.8);
        }
        break;
      }
      case "sold":
        this.entities.markSold(ev.id);
        sfx.play("sell");
        break;
      case "hit":
        if (ev.faction !== PLAYER || gameMode.spectator) return;
        if (this.simSeconds - this.lastAlert > 12) {
          if (!this.stage.rig.onScreen(ev.x, ev.y)) {
            this.lastAlert = this.simSeconds;
            sfx.play("alert", 0.8);
            const hq = ev.building && w.buildings.get(ev.id)?.kind === "hq";
            const hitUnit = ev.building ? undefined : w.units.get(ev.id);
            const goliath = !!hitUnit?.goliath;
            // (a drop to 1× for this attack already put "Speed 1× — HQ under attack" in the ticker)
            if (!(hq && this.aware.slowedFor("hq")) && !(goliath && this.aware.slowedFor("goliath")))
              this.hud.alert(hq ? `${displayName("hq", nationOf(w, PLAYER))} ${agree("hq", "attaqué", nationOf(w, PLAYER))} !` : goliath ? `${UNITS[hitUnit!.kind].name} attaqué !` : ev.building ? "Base attaquée !" : "Unités attaquées !", ev.x, ev.y);
          }
        }
        this.hud.ping(ev.x, ev.y);
        break;
      case "rankUp": {
        const u = w.units.get(ev.id);
        // (a Veterans crate promotes a hidden Sniper Team too: no gold ring on its spot)
        if (!u || !this.unitVisible(u)) return;
        const p = this.entities.pos(u.id);
        this.fx.pulse(u.x, u.y, 0xffd66e, 1, UNITS[u.kind].domain === "air" && p ? p.h - 0.1 : undefined);
        if (u.faction === PLAYER && !voices.answers(this.voiceHooks)) sfx.play("rank", 0.7); // else a voiced sparkle
        break;
      }
    }
  }

  // -------------------------------------------------------------- render ---

  private tileVisible(x: number, y: number): boolean {
    if (!this.ctrl.showFog) return true; // debug: reveal everything
    return isVisible(this.world, this.fogSide, Math.floor(x), Math.floor(y));
  }

  /**
   * May the local player see this unit? Ours always; an enemy when its tile
   * is in sight and it isn't a Sniper Team hidden in the woods (unitSeenBy).
   */
  private unitVisible(u: Unit): boolean {
    if (u.faction === this.fogSide || !this.ctrl.showFog) return true;
    return unitSeenBy(this.world, this.fogSide, u);
  }

  private buildingShown(b: Building): boolean {
    if (!this.ctrl.showFog) return true;
    if (b.faction === this.fogSide || this.world.fog[this.fogSide].known.has(b.id)) return true;
    const c = buildingCenter(b);
    return this.tileVisible(c.x, c.y);
  }

  /**
   * Does the blast of a building dying at (x, y) go off on screen? Its own
   * sight dies with it (the fog may already be recomputed without it: every
   * third tick, at the end of the step), so ours always do. So does every
   * blast in the tick that decides the match, the HQ's among them: the finale
   * glides onto it and the match is over (render/entities.ts drops its
   * ghosts then too). Otherwise an enemy's goes off only where we can see
   * part of its footprint — one that falls in the fog stays standing, as
   * remembered, until we look again (render/entities.ts).
   */
  private buildingBlastShown(x: number, y: number, size: number): boolean {
    if (!this.ctrl.showFog || this.world.winner) return true;
    // (the death event right after the explosion says whose it was; a Gantry is always in sight)
    for (const e of this.world.fx)
      if (e.type === "death" && e.buildingKind !== null && e.x === x && e.y === y) {
        if (e.faction === this.fogSide || BUILDINGS[e.buildingKind].alwaysVisible) return true;
        break;
      }
    const x0 = x - size / 2;
    const y0 = y - size / 2;
    for (let dy = 0; dy < size; dy++)
      for (let dx = 0; dx < size; dx++) if (this.tileVisible(x0 + dx + 0.5, y0 + dy + 0.5)) return true;
    return false;
  }

  /** The Goliath that died at (x, y) this tick, if the unit blast there is a Goliath's (its death event says so). */
  private goliathDeathAt(x: number, y: number): number | null {
    for (const e of this.world.fx) if (e.type === "death" && e.unitKind === "goliath" && e.x === x && e.y === y) return e.id;
    return null;
  }

  /**
   * Selection rings, order lines and waypoints, building selection and range,
   * the wave marker, placement. Selection outranks the combat rings under it
   * (bolder, fully opaque, a faint fill under our own units); a selection's
   * orders share one waypoint per target, joined by thin unhaloed lines.
   */
  private drawWorldMarks(): void {
    const g = this.view.ground;
    const w = this.world;
    const marks = this.waypoints;
    let nMarks = 0;
    const routes = new Set<string>();
    for (const id of this.ctrl.selectedUnits) {
      const u = w.units.get(id);
      const p = this.entities.pos(id);
      if (!u || !p) continue;
      const air = UNITS[u.kind].domain === "air";
      const r = UNITS[u.kind].radius * 1.12 + 0.14;
      const own = u.faction === PLAYER;
      // aircraft: ring the craft itself (at altitude), not the ground under it
      const at = air ? p.h - 0.1 : undefined;
      if (own) g.fillStyle(0x7ef29b, 0.1).fillEllipse(p.x, p.y, r * 2.1, r * 2.1, at);
      // (Panache: a finer ring, less ink on a crowded field)
      g.lineStyle(BELLE_EPOQUE ? 1.6 : 2.5, own ? 0x7ef29b : 0xff7a6a, 1).strokeEllipse(p.x, p.y, r * 2.1, r * 2.1, at);
      if (!own) continue;
      const o = u.order;
      let tx = 0;
      let ty = 0;
      let key = 0;
      let col = 0x7ef29b;
      if (o.type === "move" || o.type === "attackMove") {
        tx = o.x;
        ty = o.y;
        // (orders to the same tile share a waypoint: one tap sends the whole selection there)
        key = (Math.floor(o.x) * 4096 + Math.floor(o.y)) * 2 + (o.type === "move" ? 2 : 1);
        col = o.type === "move" ? 0x7ec1ff : 0x7ef29b;
      } else if (o.type === "attack") {
        const t = this.entities.pos(o.targetId);
        if (!t || !this.entities.isShown(o.targetId)) continue;
        tx = t.gx;
        ty = t.gy;
        key = -1 - o.targetId;
        col = 0xff5a4a;
      } else if (o.type === "board") {
        // a squad walking to its Condor: a blue line to the craft
        const t = this.entities.pos(o.carrierId);
        if (!t) continue;
        tx = t.gx;
        ty = t.gy;
        key = -1e7 - o.carrierId;
        col = 0x7ec1ff;
      } else if (o.type === "unload") {
        // a Condor flying a drop: a gold waypoint where the squads land
        tx = o.x;
        ty = o.y;
        key = -2e7 - (Math.floor(o.x) * 4096 + Math.floor(o.y));
        col = 0xffe066;
      } else continue;
      let m = 0;
      while (m < nMarks && marks[m]!.key !== key) m++;
      if (m === nMarks) {
        const mk = marks[nMarks] ?? (marks[nMarks] = { key: 0, x: 0, y: 0, col: 0 });
        mk.key = key;
        mk.x = tx;
        mk.y = ty;
        mk.col = col;
        nMarks++;
      }
      const mk = marks[m]!;
      // the line stops at the waypoint's ring
      const dx = mk.x - p.gx;
      const dy = mk.y - p.gy;
      const d = Math.hypot(dx, dy);
      const stop = WAYPOINT_PX * g.px(mk.x, mk.y);
      if (d > stop) g.lineStyle(1.2, col, 0.35, 0).lineBetween(p.gx, p.gy, mk.x - (dx / d) * stop, mk.y - (dy / d) * stop);
      // the rest of a route drawn, or a patrol's round, beyond that waypoint
      if (u.route) drawQueuedRoute(g, u, col, routes);
    }
    this.sketch.draw(this.view.over, performance.now(), this.ctrl.forceMove);
    for (let i = 0; i < nMarks; i++) {
      const mk = marks[i]!;
      const px = g.px(mk.x, mk.y);
      g.lineStyle(1.5, mk.col, 0.85).strokeCircle(mk.x, mk.y, WAYPOINT_PX * px);
      g.fillStyle(mk.col, 0.9).fillCircle(mk.x, mk.y, 2.5 * px);
    }

    const sb = this.ctrl.selectedBuilding !== null ? w.buildings.get(this.ctrl.selectedBuilding) : null;
    if (sb) {
      const size = BUILDINGS[sb.kind].size;
      g.lineStyle(2.5, 0x7ef29b, 1).strokeRect(sb.tx + 0.03, sb.ty + 0.03, size - 0.06, size - 0.06);
      const st = BUILDINGS[sb.kind];
      const c = buildingCenter(sb);
      if (st.range > 0) g.lineStyle(1.2, 0xffffff, 0.3).strokeCircle(c.x, c.y, st.range + size / 2);
      // (a sound duel: a new rally point still on its way already shows)
      const rally = this.ctrl.ahead().rally(sb.id) ?? sb.rally;
      if (rally) g.lineStyle(1.5, 0xffe066, 0.8).lineBetween(c.x, c.y, rally.x, rally.y).strokeCircle(rally.x, rally.y, 0.16);
    }
    // Goliaths' build rings, threat rings and anchoring arcs (read through the fog: they're always seen)
    this.entities.goliathMarks(this.view.over, this.ctrl.selectedUnits);
    this.survival?.drawOverlay(performance.now());
    this.tutorial?.drawWorld(this.view.over);
    this.place.draw();
  }

  /** Screen-space marks over the 3D view: health and production bars, chevrons, the box select. */
  private drawScreen(): void {
    const rig = this.stage.rig;
    const ctx = this.stage.screen.begin();
    const w = this.world;
    // health bars (damaged or selected) and veterancy
    for (const u of w.units.values()) {
      const max = UNITS[u.kind].hp;
      const selected = this.ctrl.selectedUnits.has(u.id);
      const harvesterLoad = behaves(u.kind, "harvester") && u.faction === PLAYER && selected;
      if (u.hp >= max && !selected) continue;
      if (!this.entities.isShown(u.id)) continue;
      const p = this.entities.pos(u.id);
      if (!p) continue;
      const s = rig.project(p.x, p.y, p.top + 0.12);
      if (s.behind) continue;
      if (u.goliath) {
        // a Goliath's bar is wider and taller, notched where each weapon goes offline
        const gw = Math.min(120, Math.max(60, (UNITS[u.kind].radius * 2.4) / rig.worldPerPx(p.x, p.y)));
        // (amber while that weapon is down: offline, or rebooting after the Menders brought it back)
        GOLIATH_MARK_WEAPONS.forEach((k, i) => (goliathDown[i] = !u.goliath!.weapons[k].online));
        this.juice.healthBar(ctx, u.id, s.x - gw / 2, s.y - 11, gw, u.hp / max, u.faction === PLAYER, 5, GOLIATH_MARKS, goliathDown);
        continue;
      }
      const bw = Math.min(64, Math.max(30, (UNITS[u.kind].radius * 2.2) / rig.worldPerPx(p.x, p.y)));
      this.juice.healthBar(ctx, u.id, s.x - bw / 2, s.y - 10, bw, u.hp / max, u.faction === PLAYER);
      // the load rides 2 px under the health bar, in the same frame style
      if (harvesterLoad) this.juice.meter(ctx, s.x - bw / 2, s.y - 4, bw, 3, u.cargo / ECONOMY.harvesterCapacity, "#ffd66e");
    }
    // infantry training under our own anchored Goliaths
    for (const u of w.units.values()) {
      const head = u.goliath?.queue[0];
      if (!head || u.faction !== PLAYER || !this.entities.isShown(u.id)) continue;
      const p = this.entities.pos(u.id);
      if (!p) continue;
      const s = rig.project(p.x, p.y, p.h);
      if (s.behind) continue;
      const mw = Math.min(90, Math.max(44, 1.6 / rig.worldPerPx(p.x, p.y)));
      this.juice.meter(ctx, s.x - mw / 2, s.y + 6, mw, 4, 1 - head.remaining / (UNITS[head.kind].buildTime * TICK_RATE), METER[u.faction]);
    }
    for (const b of w.buildings.values()) {
      const size = BUILDINGS[b.kind].size;
      if (!this.entities.isShown(b.id)) continue;
      const p = this.entities.pos(b.id);
      if (!p) continue;
      const bw = Math.min(150, Math.max(36, (size * 0.8) / rig.worldPerPx(p.x, p.y)));
      // (none on an enemy building we only remember: its health is out of sight)
      const ratio = this.entities.shownHp(b.id);
      if (ratio !== null && (ratio < 1 || this.ctrl.selectedBuilding === b.id)) {
        const s = rig.project(p.x, p.y, p.top + 0.1);
        if (!s.behind) this.juice.healthBar(ctx, b.id, s.x - bw / 2, s.y - 11, bw, ratio, b.faction === PLAYER, 5);
      }
      // production progress under our factories (and under an enemy Gantry: its Goliath is public)
      const head = b.queue[0];
      if (head && (b.faction === PLAYER || BUILDINGS[b.kind].alwaysVisible)) {
        const total = UNITS[head.kind].buildTime * TICK_RATE;
        const s = rig.project(p.x, b.ty + size, p.h - 0.4);
        if (!s.behind) this.juice.meter(ctx, s.x - bw / 2, s.y - 8, bw, 4, 1 - head.remaining / total, METER[b.faction]);
      }
    }
    // veterancy chevrons float above the unit, on the device pixel grid (crisp, and no shimmer as the camera glides)
    const dpr = this.dpr;
    const chev = this.chevrons;
    let n = 0;
    for (const r of this.entities.ranked()) {
      const s = rig.project(r.x, r.y, r.h + 0.12);
      if (s.behind) continue;
      // (Panache: small pips just over the health bar)
      const y = Math.round((s.y - (BELLE_EPOQUE ? 15 : 20)) * dpr) / dpr;
      const k = BELLE_EPOQUE ? 0.55 : 0.8;
      const step = BELLE_EPOQUE ? 10 : 14;
      for (let i = 0; i < r.rank; i++) {
        const last = i === r.rank - 1;
        chev[n++] = Math.round((s.x - ((r.rank - 1) * step) / 2 + i * step) * dpr) / dpr;
        chev[n++] = y;
        chev[n++] = last ? k + (1 - r.pop) * k : k;
      }
    }
    if (n > 0) {
      // a soft drop shadow lifts the gold off sand and snow: the same shapes a pixel lower, dark with a
      // feathered rim (one path for them all, and no canvas shadowBlur, which blurs a mask per draw)
      const drop = Math.max(1, Math.round(dpr)) / dpr;
      ctx.beginPath();
      for (let i = 0; i < n; i += 3) chevron(ctx, chev[i]!, chev[i + 1]! + drop, chev[i + 2]!);
      ctx.fillStyle = "rgba(0,0,0,0.45)";
      ctx.fill();
      ctx.lineWidth = 2.6;
      ctx.strokeStyle = "rgba(0,0,0,0.2)";
      ctx.stroke();
      ctx.beginPath();
      for (let i = 0; i < n; i += 3) chevron(ctx, chev[i]!, chev[i + 1]!, chev[i + 2]!);
      ctx.fillStyle = "#ffd66e";
      ctx.fill();
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = "#3a2a00";
      ctx.stroke();
    }
    if (this.boxRect) {
      const b = this.boxRect;
      // edges through device pixel centres: the strokes sit on the pixel grid instead of straddling it
      const x = pxCentre(Math.min(b.x0, b.x1), dpr);
      const y = pxCentre(Math.min(b.y0, b.y1), dpr);
      const bw = pxCentre(Math.max(b.x0, b.x1), dpr) - x;
      const bh = pxCentre(Math.max(b.y0, b.y1), dpr) - y;
      ctx.fillStyle = "rgba(126,242,155,0.08)";
      ctx.fillRect(x, y, bw, bh);
      // marching green dashes, each with a 1 px dark rim (a dash 1 px longer at both ends): the edge
      // reads on snow, and on sand the gaps stay sand instead of making a dark frame
      const march = (performance.now() / 40) % 10;
      ctx.setLineDash(DASH_RIM);
      ctx.lineDashOffset = 1 - march;
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = "rgba(4,7,12,0.55)";
      ctx.strokeRect(x, y, bw, bh);
      ctx.setLineDash(DASH);
      ctx.lineDashOffset = -march;
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "rgba(126,242,155,0.95)";
      ctx.strokeRect(x, y, bw, bh);
      ctx.setLineDash(NO_DASH);
      ctx.lineDashOffset = 0;
    }
    this.stage.screen.drawLabels();
  }

  // --------------------------------------------------------------- input ---

  private worldAt(sx: number, sy: number): { x: number; y: number } {
    return this.stage.rig.ground(sx, sy);
  }

  private canSee = (id: number): boolean => this.entities.isShown(id);

  /**
   * What's under a screen point: the nearest drawn unit (aircraft where they
   * fly, not their shadow), else the building whose 3D bulk covers the point,
   * else the ground.
   */
  private pick(sx: number, sy: number): TapHit {
    const rig = this.stage.rig;
    const w = this.world;
    let best: TapHit = { kind: "ground" };
    let bestD = Infinity;
    for (const u of w.units.values()) {
      // (a concealed Sniper Team can't be tapped, even before the renderer hides it)
      if (u.faction !== PLAYER && (!this.canSee(u.id) || !this.unitVisible(u))) continue;
      const p = this.entities.pos(u.id);
      if (!p) continue;
      const s = rig.project(p.x, p.y, (p.h + p.top) / 2);
      const r = Math.max(24, (UNITS[u.kind].radius * 1.15) / rig.worldPerPx(p.x, p.y));
      const d = Math.hypot(s.x - sx, s.y - sy);
      if (d < r && d < bestD) {
        bestD = d;
        best = u.faction === PLAYER ? { kind: "ownUnit", id: u.id } : { kind: "enemy", id: u.id, targetsAir: domainOf(u) === "air" };
      }
    }
    if (best.kind !== "ground") return best;
    for (const b of w.buildings.values()) {
      if (b.faction !== PLAYER && !this.canSee(b.id)) continue;
      const p = this.entities.pos(b.id);
      if (!p) continue;
      const size = BUILDINGS[b.kind].size;
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      const base = p.h - 0.4;
      for (const [dx, dy] of [[0, 0], [size, 0], [0, size], [size, size]] as [number, number][])
        for (const h of [base, base + Math.min(p.top - base, size * 0.55)]) {
          const s = rig.project(b.tx + dx, b.ty + dy, h);
          x0 = Math.min(x0, s.x);
          y0 = Math.min(y0, s.y);
          x1 = Math.max(x1, s.x);
          y1 = Math.max(y1, s.y);
        }
      if (sx < x0 || sx > x1 || sy < y0 || sy > y1) continue;
      const s = rig.project(p.x, p.y, base);
      const d = Math.hypot(s.x - sx, s.y - sy);
      if (d < bestD) {
        bestD = d;
        best = b.faction === PLAYER ? { kind: "ownBuilding", id: b.id } : { kind: "enemy", id: b.id, targetsAir: false };
      }
    }
    return best;
  }

  /**
   * Does a one-finger drag from screen point (sx, sy) draw a route? When it
   * starts on (or within a thumb of) a unit of the player's selection, and
   * nothing else owns the map: a placement, an armed calldown, a spectator.
   */
  private routeStartsAt(sx: number, sy: number): boolean {
    const ctrl = this.ctrl;
    if (ctrl.selectedUnits.size === 0 || ctrl.placing || ctrl.spectator || ctrl.boxNext || this.powerUi?.targeting) return false;
    const rig = this.stage.rig;
    for (const id of ctrl.selectedUnits) {
      const u = this.world.units.get(id);
      const p = u?.faction === PLAYER ? this.entities.pos(id) : null;
      if (!p) continue;
      const s = rig.project(p.x, p.y, (p.h + p.top) / 2);
      if (Math.hypot(s.x - sx, s.y - sy) <= Math.max(30, (UNITS[u!.kind].radius * 1.3) / rig.worldPerPx(p.x, p.y))) return true;
    }
    return false;
  }

  private setupInput(): void {
    const rig = this.stage.rig;
    /** Shift was held on the click that fires a tap: it adds or removes a unit. */
    let shift = false;
    this.gest = new GestureRecognizer({
      onTap: (sx, sy, type) => {
        if (this.place.tap(sx, sy, type)) return; // placing: move the ghost / build
        const p = this.worldAt(sx, sy);
        if (this.powerUi?.tapWorld(p.x, p.y)) return; // an armed calldown fires here
        this.ctrl.tapWorld(p.x, p.y, this.pick(sx, sy), shift);
      },
      onDoubleTap: (sx, sy) => {
        if (this.place.tap(sx, sy)) return; // 2nd tap lands on the ghost it just moved: build
        const hit = this.pick(sx, sy);
        if (hit.kind !== "ownUnit") return;
        if (shift) return this.ctrl.toggleUnit(hit.id); // quick Shift+clicks each toggle a unit
        const kind = this.world.units.get(hit.id)?.kind;
        const ids = [...this.world.units.values()]
          .filter((u) => u.faction === PLAYER && u.kind === kind && rig.onScreen(u.x, u.y))
          .map((u) => u.id);
        this.ctrl.selectUnits(ids);
      },
      onBoxStart: (sx, sy) => {
        this.boxRect = { x0: sx, y0: sy, x1: sx, y1: sy };
        this.ctrl.boxNext = false; // (▢ Cadre: one box per tap)
      },
      onBoxMove: (sx, sy) => {
        if (this.boxRect) {
          this.boxRect.x1 = sx;
          this.boxRect.y1 = sy;
        }
      },
      onBoxEnd: (sx, sy, released) => {
        if (!this.boxRect) return;
        const b = this.boxRect;
        this.boxRect = null;
        // cut short (a second finger to pinch, a cancelled pointer): no drop, no selection
        if (!released) return;
        // a long-press released without dragging (the degenerate box): an armed
        // calldown fires there (press and hold to aim), as a tap would; else, with
        // loaded Condors selected, they fly there and drop their squads (and a
        // lift selected flies its Goliath there and sets it down)
        if (isHoldRelease(b.x0, b.y0, sx, sy)) {
          const p = this.worldAt(sx, sy);
          if (this.powerUi?.tapWorld(p.x, p.y)) return;
          if (this.ctrl.dropAt(p.x, p.y)) return;
        }
        const x0 = Math.min(b.x0, sx);
        const y0 = Math.min(b.y0, sy);
        const x1 = Math.max(b.x0, sx);
        const y1 = Math.max(b.y0, sy);
        // select what is DRAWN inside the box (aircraft by where they fly)
        const inBox = [...this.world.units.values()].filter((u) => {
          if (u.faction !== PLAYER) return false;
          const p = this.entities.pos(u.id);
          const s = p ? rig.project(p.x, p.y, (p.h + p.top) / 2) : rig.project(u.x, u.y);
          return s.x >= x0 && s.x <= x1 && s.y >= y0 && s.y <= y1;
        });
        // prefer combat units: a box over the mining line shouldn't grab harvesters
        const army = inBox.filter((u) => !behaves(u.kind, "harvester"));
        const ids = (army.length > 0 ? army : inBox).map((u) => u.id);
        if (ids.length > 0) this.ctrl.selectUnits(ids);
      },
      onPan: (dx, dy) => {
        this.cine?.hold();
        rig.pan(dx, dy);
        this.lastPan = { x: dx, y: dy };
        this.glide = null;
      },
      onPanEnd: () => {
        if (Math.hypot(this.lastPan.x, this.lastPan.y) > 3) this.glide = { ...this.lastPan };
        this.lastPan = { x: 0, y: 0 };
      },
      onPinch: (scale, cx, cy) => {
        this.cine?.hold();
        rig.zoomAround(this.clampedZoom(rig.zoom * scale), cx, cy);
        this.targetZoom = rig.zoom; // pinch is immediate; keep target in sync
      },
      onRightClick: (sx, sy) => {
        if (this.powerUi?.targeting) return this.powerUi.cancel(); // right-click disarms a calldown
        if (this.ctrl.placing) {
          this.ctrl.placing = null; // right-click cancels placement
          return;
        }
        const p = this.worldAt(sx, sy);
        let hit = this.pick(sx, sy);
        // right-click on our own Condor with squads selected (or a squad with Condors selected) loads it,
        // and on our own Goliath with two empty Condors selected lifts it
        if (hit.kind === "ownUnit" && this.ctrl.boardTap(hit.id)) return;
        // right-click never re-selects; own entities count as ground
        if (hit.kind === "ownUnit" || hit.kind === "ownBuilding") hit = { kind: "ground" };
        this.ctrl.tapWorld(p.x, p.y, hit);
      },
      onWheel: (deltaY, sx, sy) => this.zoomBy(deltaY > 0 ? 0.85 : 1.18, sx, sy),
      // a drag from a selected unit draws the selection's route (route-view.ts, Controller.routeSelected)
      routeFrom: (sx, sy) => this.routeStartsAt(sx, sy),
      boxNow: () => this.ctrl.boxNext,
      onRouteStart: (sx, sy) => this.sketch.start(this.worldAt(sx, sy)),
      onRouteMove: (sx, sy) => this.sketch.move(this.worldAt(sx, sy)),
      onRouteEnd: (sx, sy, released) => {
        const plan = this.sketch.end(released ? this.worldAt(sx, sy) : null, released, performance.now(), this.ctrl.forceMove);
        if (plan && this.ctrl.routeSelected(plan.points, plan.loop)) this.command?.seen("route");
      }
    });

    const canvas = this.stage.canvas;
    const toPointer = (e: PointerEvent): GesturePointer => {
      const r = canvas.getBoundingClientRect();
      return {
        id: e.pointerId,
        x: e.clientX - r.left,
        y: e.clientY - r.top,
        pointerType: (e.pointerType || "mouse") as GesturePointer["pointerType"],
        button: e.button
      };
    };
    // an armed calldown's preview follows the mouse, or the finger on the map
    const aim = (p: GesturePointer) => {
      if (!this.powerUi?.targeting) return;
      const q = this.worldAt(p.x, p.y);
      this.powerUi.aim(q.x, q.y);
    };
    /** Touch pointers down on the map, where last seen (client px): checked against the real fingers. */
    const fingers = new Map<number, { x: number; y: number }>();
    const down = (e: PointerEvent) => {
      if (this.finale) return; // the camera belongs to the cinematic now
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic events can't be captured */
      }
      this.glide = null; // touching the map stops any glide
      if (e.pointerType === "touch") fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const p = toPointer(e);
      aim(p);
      if (this.place.down(p)) return; // a finger on the ghost drags it
      this.gest.down(p, performance.now());
    };
    const move = (e: PointerEvent) => {
      const f = fingers.get(e.pointerId);
      if (f) {
        f.x = e.clientX;
        f.y = e.clientY;
      }
      const p = toPointer(e);
      aim(p);
      if (!this.place.move(p)) this.gest.move(p, performance.now());
    };
    const up = (e: PointerEvent) => {
      fingers.delete(e.pointerId);
      const p = toPointer(e);
      shift = e.shiftKey;
      if (!this.place.up(p)) this.gest.up(p, performance.now());
    };
    const cancel = (e: PointerEvent) => {
      fingers.delete(e.pointerId);
      const p = toPointer(e);
      if (!this.place.up(p)) this.gest.cancel(p);
    };
    // iOS Safari can end a touch with neither pointerup nor pointercancel (an
    // abandoned edge swipe), leaving a finger counted as down for good: every
    // later touch became the second finger of a pinch (pan and zoom still
    // worked; taps and boxes never did). Each touchstart lists the fingers
    // really down (wherever they landed): let go of pointers with none there.
    const touchstart = (e: TouchEvent) => {
      const gone = strandedPointers(fingers, e.touches);
      if (gone.length === 0) return;
      for (const id of gone) {
        fingers.delete(id);
        this.place.forget(id);
      }
      this.gest.forget(gone, performance.now());
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      if (this.finale) return;
      const r = canvas.getBoundingClientRect();
      this.gest.wheel(e.deltaY, e.clientX - r.left, e.clientY - r.top);
    };
    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", cancel);
    window.addEventListener("touchstart", touchstart, { capture: true, passive: true });
    canvas.addEventListener("wheel", wheel, { passive: false });

    const typing = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
    };
    const keydown = (e: KeyboardEvent) => {
      if (typing(e)) return;
      if (/^Arrow/.test(e.code) || ["KeyW", "KeyA", "KeyS", "KeyD"].includes(e.code)) {
        if (!e.ctrlKey && !e.metaKey) {
          this.keys.add(e.code);
          this.cine?.hold();
        }
        if (/^Arrow/.test(e.code)) e.preventDefault();
      }
      if (e.key === "Escape") {
        this.powerUi?.cancel();
        this.ctrl.placing = null;
        this.ctrl.clearSelection();
        return;
      }
      if (this.finale || e.repeat) return; // (the cinematic: no zoom, squads or jumps)
      if (e.key === "+" || e.key === "=") this.zoomBy(1.3);
      else if (e.key === "-" || e.key === "_") this.zoomBy(1 / 1.3);
      else if ((e.key === "p" || e.key === " ") && !this.holdStart) {
        if (e.key === " ") e.preventDefault();
        this.hud.togglePause();
      } else if (e.key === "q") this.ctrl.selectArmy();
      else if (e.key === "u") this.ctrl.unloadSelected();
      else if (e.key === "g") this.ctrl.toggleAnchor(); // selected Goliaths anchor, or pack up
      else if (e.key === "Delete") this.ctrl.sellSelected();
      else if (e.key === "." && !this.interactive) this.aware.cycleSpeed(); // (a duel runs at one speed)
      else if (e.key === "j") this.aware.jump();
      else if (e.key === "c") this.toggleCine();
      else if (/^Digit[1-3]$/.test(e.code)) {
        // squads: 1–3 select (twice: fly there); Ctrl/Cmd/Shift + 1–3 save
        const save = e.ctrlKey || e.metaKey || e.shiftKey;
        if (save) e.preventDefault();
        this.command.key(Number(e.code.slice(5)) - 1, save);
      }
    };
    const keyup = (e: KeyboardEvent) => this.keys.delete(e.code);
    const blur = () => this.keys.clear();
    window.addEventListener("keydown", keydown);
    window.addEventListener("keyup", keyup);
    window.addEventListener("blur", blur);
    this.teardown.push(() => {
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", cancel);
      window.removeEventListener("touchstart", touchstart, { capture: true });
      canvas.removeEventListener("wheel", wheel);
      window.removeEventListener("keydown", keydown);
      window.removeEventListener("keyup", keyup);
      window.removeEventListener("blur", blur);
    });
  }

  private clampedZoom(z: number): number {
    const rig = this.stage.rig;
    // zoomed all the way out, a big screen may take in (most of) the whole map
    const fit = Math.min(rig.width / (this.world.width + 8), rig.height / (this.world.height * 0.8 + 8));
    return Math.min(MAX_ZOOM, Math.max(Math.max(fit, MIN_ZOOM), z));
  }

  private clampZoom(): void {
    const rig = this.stage.rig;
    rig.zoom = this.clampedZoom(rig.zoom);
    rig.apply();
    this.targetZoom = rig.zoom;
  }

  /** Tear the match down (not needed between matches: a rematch reloads the page). */
  destroy(): void {
    cancelAnimationFrame(this.raf);
    for (const f of this.teardown) f();
    this.fx.destroy();
    this.entities.destroy();
    this.terrain.dispose();
    this.stage.destroy();
  }
}

const SPOT_SHAKE = SPOTLIGHT.shake;

/** localStorage, or null where it's blocked. */
function safeStorage(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

/** Where a Goliath's weapons go offline, notched on its health bar (mortars, laser, cannons). */
const GOLIATH_MARK_WEAPONS = ["mortars", "laser", "cannons"] as const;
const GOLIATH_MARKS = GOLIATH_MARK_WEAPONS.map((k) => GOLIATH.weapons[k].lostBelow);
/** Which of those weapons are down (refilled per Goliath as its bar is drawn). */
const goliathDown = [false, false, false];

/** The centre of the device pixel under CSS coordinate `v`. */
function pxCentre(v: number, dpr: number): number {
  return (Math.floor(v * dpr) + 0.5) / dpr;
}

/** Add a rank chevron centred on (x, y), scaled by k, to the current path (drawn gold by drawScreen). */
function chevron(ctx: CanvasRenderingContext2D, x: number, y: number, k: number): void {
  ctx.moveTo(x - 9 * k, y - 2 * k);
  ctx.lineTo(x, y - 6.5 * k);
  ctx.lineTo(x + 9 * k, y - 2 * k);
  ctx.lineTo(x + 9 * k, y + 4 * k);
  ctx.lineTo(x, y - 0.5 * k);
  ctx.lineTo(x - 9 * k, y + 4 * k);
  ctx.closePath();
}
