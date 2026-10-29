/**
 * « Revoir les temps forts »: a saved match's highlight reel (game/reel.ts
 * plans it), played in the game's own 3D view as a silent film, and filmed
 * to a video to share.
 *
 * The match is a battle record played by the battle viewer's feed
 * (game/replay.ts) in spectator mode, with the director's cinematic camera
 * (game/director.ts). This feed holds the playhead between clips (commands()
 * returns null past `limit`) and seeks ahead behind each intertitle, a slice
 * per frame so the card stays smooth; each clip opens with a cut onto its
 * moment (GameScene.cutTo) and the director takes it from there. The end's
 * clip runs into the match's own finale, then « Fin ».
 *
 * What's on screen is one canvas over everything: each frame the 3D view and
 * its 2D overlay drawn in (GameScene calls rendered() right after drawing,
 * while the WebGL canvas still holds the frame), under the old-film look of
 * the intro (title.ts: sepia, grain, flicker, vignette), letterboxed, with
 * the moment's line in the bottom bar; the intertitles are drawn on it too,
 * in the gold Art Nouveau frame (the same ornaments, as Path2D). So the
 * film is exactly that canvas: canvas.captureStream + MediaRecorder, with
 * the game's sound (sfx.capture), in the first video type the browser
 * records (MP4 first: Safari records nothing else), at most 1280 px and
 * ~2 Mbit/s, paused while a seek holds an intertitle longer than its time.
 * Then « 📤 Partager le film » hands the file to navigator.share where
 * canShare allows files (a tap: sharing needs one), else downloads it.
 * Without MediaRecorder or captureStream, the film button says so and the
 * record (.json) is offered instead.
 *
 * Loaded only when a reel is asked for (main.ts), like the battle viewer.
 */
import "./reel.css";
import type { BattleRecord } from "../arena/record";
import { encodeRecord } from "../game/archive";
import { sfx } from "../game/audio";
import { fmtTime } from "../game/chronicle";
import type { GameScene } from "../game/GameScene";
import { music } from "../game/music";
import { FILM_BPS, FILM_MAX_PX, REEL, clipDeadlines, clipsOf, filmName, pickVideoType, recordName, type Clip } from "../game/reel";
import { ReplayFeed } from "../game/replay";
import { TICK_RATE } from "../sim/balance";
import { mapById } from "../sim/maps";
import type { Faction } from "../sim/types";
import { fleuron, ornament } from "./title";
import { tr } from "../lang";

/** A seek may take this long per frame (ms) behind an intertitle. */
const SEEK_BUDGET_MS = 22;
const SEEK_SLICE = 40;
/** Give up on the end's finale this long after the last tick (a record cut short, a drift). */
const END_WAIT_MS = 4500;

const GOLD = "#c9a24f";
const IVORY = "#f1e6c8";
const SERIF = `"Didot", "Bodoni 72", "Iowan Old Style", "Palatino", Georgia, "Times New Roman", serif`;

export interface ReelOpts {
  /** Back to the menu (a reload). */
  onMenu(): void;
}

/** The highlight reel of a saved match, ready for GameScene (main.ts begins a spectator match with it). */
export function reelFeed(record: BattleRecord, opts: ReelOpts): ReelFeed {
  return new ReelFeed(record, opts);
}

/** A saved match played whole in the battle viewer (the Archives' 🎬 Revoir). */
export const viewerFeed = (record: BattleRecord): ReplayFeed => new ReplayFeed(record, null, false);

export class ReelFeed extends ReplayFeed {
  /** The playhead holds at this tick. */
  limit = 0;
  /** Game speed while a clip plays. */
  pace = 1;
  readonly player: ReelPlayer;

  constructor(record: BattleRecord, opts: ReelOpts) {
    super(record, null, false);
    this.player = new ReelPlayer(this, record, opts);
  }

  override commands(tick: number) {
    return tick >= this.limit ? null : super.commands(tick);
  }

  speed(): number {
    return this.pace;
  }

  override attach(scene: GameScene): void {
    // (no seek bar or orders panel: the reel is the whole screen)
    this.scene = scene;
    (window as unknown as Record<string, unknown>).__reel = this.player;
    this.player.mount(scene);
  }

  override frame(deltaMs: number): void {
    super.frame(deltaMs);
    this.player.advance();
  }

  rendered(view: HTMLCanvasElement, overlay: HTMLCanvasElement): void {
    this.player.draw(view, overlay);
  }

  ended(): boolean {
    this.player.finaleDone();
    return true;
  }
}

type Step = { kind: "title" } | { kind: "card"; clip: Clip } | { kind: "play"; clip: Clip } | { kind: "fin" };

/** Can this browser film the reel? */
export function canFilm(): boolean {
  return (
    typeof MediaRecorder === "function" &&
    typeof HTMLCanvasElement !== "undefined" &&
    typeof HTMLCanvasElement.prototype.captureStream === "function" &&
    pickVideoType((t) => MediaRecorder.isTypeSupported(t), false) !== null
  );
}

export class ReelPlayer {
  private scene: GameScene | null = null;
  private root!: HTMLElement;
  private cv!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private ui!: HTMLElement;
  private readonly clips: Clip[];
  private readonly deadlines: number[];
  private steps: Step[] = [];
  private at = -1;
  private stepAt = 0;
  /** Projecting (false: the title waiting for a tap, or « Fin » with its buttons). */
  private running = false;
  private seekTo: number | null = null;
  private finaleOver = false;
  private reachedAt = 0;
  private film: Film | null = null;
  /** The last film made, ready to share. */
  private made: File | null = null;
  private note = "";
  private grain: HTMLCanvasElement | null = null;
  private readonly reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  private readonly pov: Faction;

  constructor(private feed: ReelFeed, private record: BattleRecord, private opts: ReelOpts) {
    this.clips = clipsOf(record);
    this.deadlines = clipDeadlines(this.clips);
    this.pov = record.played?.pov ?? "blue";
  }

  /** For tools/reel-check.mjs and the console: where the reel is. */
  get phase(): string {
    return this.at < 0 ? "idle" : this.steps[this.at]?.kind ?? "done";
  }
  get filmBytes(): number {
    return this.made?.size ?? 0;
  }
  get filmType(): string {
    return this.made?.type ?? "";
  }
  get plan(): Clip[] {
    return this.clips;
  }
  /** The first checkpoint whose hash didn't match as it played (null: none). */
  get diverged(): number | null {
    return this.feed.divergedAt;
  }

  mount(scene: GameScene): void {
    this.scene = scene;
    this.root = document.createElement("div");
    this.root.className = "reel";
    this.root.innerHTML = `<canvas class="reel-cv"></canvas><div class="reel-ui"></div>`;
    document.body.appendChild(this.root);
    this.cv = this.root.querySelector("canvas")!;
    this.ctx = this.cv.getContext("2d")!;
    this.ui = this.root.querySelector(".reel-ui")!;
    this.size();
    window.addEventListener("resize", () => this.size());
    this.feed.limit = 0;
    this.buttons("title");
  }

  /** The canvas at the screen's shape, at most FILM_MAX_PX on its longest side (not while filming: the video keeps its size). */
  private size(): void {
    if (this.film) return;
    const w = Math.max(1, innerWidth);
    const h = Math.max(1, innerHeight);
    const k = Math.min(Math.max(1, devicePixelRatio || 1), FILM_MAX_PX / Math.max(w, h));
    this.cv.width = Math.round(w * k);
    this.cv.height = Math.round(h * k);
  }

  // ---------------------------------------------------------- the reel ---

  /** Project the reel from the start; `film`: and record it. */
  start(film: boolean): void {
    sfx.unlock();
    this.made = film ? null : this.made;
    this.note = "";
    this.steps = [{ kind: "title" }];
    for (const clip of this.clips) this.steps.push({ kind: "card", clip }, { kind: "play", clip });
    this.steps.push({ kind: "fin" });
    this.running = true;
    this.finaleOver = false;
    if (film) {
      this.film = Film.start(this.cv);
      if (!this.film) this.note = tr("Ce navigateur ne sait pas filmer : le film est projeté sans être enregistré.", "This browser can't record video: the film is shown without being saved.");
    }
    this.go(0);
    // (a second showing: the battle's music again, the finale had resolved it)
    if (this.scene) music.play("battle", this.scene.world.biome);
    this.buttons("playing");
  }

  private go(i: number): void {
    this.at = i;
    this.stepAt = performance.now();
    const s = this.steps[i];
    if (!s) return;
    if (s.kind === "card") {
      this.feed.limit = this.scene?.tick ?? 0; // (hold while the card is up)
      this.seekTo = s.clip.from;
    } else if (s.kind === "play") {
      const sc = this.scene!;
      const m = s.clip.moment;
      sc.cutTo(m.x ?? null, m.y ?? null, this.pov);
      this.finaleOver = false;
      this.reachedAt = 0;
      this.feed.pace = REEL.pace;
      this.feed.limit = s.clip.to;
    } else if (s.kind === "fin") {
      this.feed.limit = this.scene?.tick ?? 0;
    }
  }

  /** The end's finale played out (GameScene asks the feed instead of showing the report). */
  finaleDone(): void {
    this.finaleOver = true;
  }

  /** Every frame, before it's drawn: seek behind a card, move on when a step is done. */
  advance(): void {
    const s = this.steps[this.at];
    const sc = this.scene;
    if (!this.running || !s || !sc) return;
    const now = performance.now();
    const age = now - this.stepAt;
    if (s.kind === "title") {
      if (age >= REEL.titleMs) this.go(this.at + 1);
    } else if (s.kind === "card") {
      const done = this.seekSlice(sc);
      if (age >= REEL.cardMs) {
        if (done) {
          this.film?.resume();
          this.go(this.at + 1);
        } else this.film?.pause(); // (the film doesn't hold a card longer than its time)
      }
    } else if (s.kind === "play") {
      const end = s.clip.moment.kind === "end";
      // a film running late (a slow device) cuts the clip at its planned time: the film stays within its 25 s
      const due = this.deadlines[this.clips.indexOf(s.clip)];
      if (!end && this.film && due !== undefined && this.film.ms > due + 300) return this.go(this.at + 1);
      if (sc.tick >= s.clip.to || sc.world.winner) {
        if (!this.reachedAt) this.reachedAt = now;
        if (!end || this.finaleOver || now - this.reachedAt > END_WAIT_MS) this.go(this.at + 1);
      }
    } else if (s.kind === "fin" && age >= REEL.finMs) {
      this.running = false;
      void this.finish();
    }
  }

  /** Seek toward the card's clip for at most SEEK_BUDGET_MS: true once there. */
  private seekSlice(sc: GameScene): boolean {
    const target = this.seekTo;
    if (target === null) return true;
    const t0 = performance.now();
    this.feed.limit = Infinity;
    try {
      if (target < sc.tick) sc.seek(target); // (another showing: back to the keyframe before it, then on)
      while (sc.tick < target && performance.now() - t0 < SEEK_BUDGET_MS) {
        const from = sc.tick;
        sc.seek(Math.min(target, from + SEEK_SLICE));
        if (sc.tick === from || sc.world.winner) break; // (nothing more to play)
      }
    } finally {
      this.feed.limit = sc.tick;
    }
    if (sc.tick >= target || sc.world.winner || sc.tick >= this.feed.playedTo) {
      this.seekTo = null;
      return true;
    }
    return false;
  }

  private async finish(): Promise<void> {
    const film = this.film;
    this.film = null;
    if (film) {
      const blob = await film.stop();
      if (blob && blob.size > 0) {
        const name = filmName(this.record.map, this.record.created, film.type);
        this.made = new File([blob], name, { type: film.type.split(";")[0] });
        this.note = tr(`Film prêt : ${(blob.size / 1e6).toFixed(1).replace(".", ",")} Mo`, `Film ready: ${(blob.size / 1e6).toFixed(1)} MB`);
      } else this.note = tr("Le film n'a pas pu être enregistré.", "The film couldn't be recorded.");
      this.size();
    }
    this.buttons("fin");
  }

  /** Cut the showing short: straight to « Fin » (a film being made is let go). */
  private skip(): void {
    if (!this.running) return;
    this.film?.discard();
    this.film = null;
    this.go(this.steps.length - 1);
  }

  // ------------------------------------------------------------ buttons ---

  private buttons(state: "title" | "playing" | "fin"): void {
    const film = canFilm();
    const why = film ? "" : tr("Ce navigateur ne sait pas filmer l'écran (MediaRecorder absent)", "This browser can't record the screen (MediaRecorder missing)");
    if (state === "playing") {
      this.ui.className = "reel-ui playing";
      this.ui.innerHTML = `${this.film ? `<span class="reel-rec">${tr("● Tournage", "● Filming")}</span>` : ""}<button class="reel-skip" data-a="skip" type="button">${tr("Passer ›", "Skip ›")}</button>`;
    } else {
      this.ui.className = `reel-ui ${state}`;
      const share = this.made
        ? `<button class="cta" data-a="share" type="button">${tr("Partager le film", "Share the film")}</button>`
        : `<button class="cta${state === "title" ? " alt" : ""}" data-a="film" type="button"${film ? "" : ` disabled title="${why}"`}>${tr("Filmer pour partager", "Film to share")}</button>`;
      this.ui.innerHTML = `<div class="reel-acts">
          ${state === "title" ? `<button class="cta big" data-a="play" type="button">${tr("▶ Projeter", "▶ Screen it")}</button>` : `<button class="cta alt" data-a="play" type="button">${tr("↻ Revoir", "↻ Rewatch")}</button>`}
          ${share}
          <button class="cta alt" data-a="json" type="button" title="${tr("La partie elle-même : elle se rejoue dans Panache (Voir une rediffusion)", "The match itself: it replays in Panache (Watch a replay)")}">${tr("⬇ Partie (.json)", "⬇ Match (.json)")}</button>
          <button class="cta alt" data-a="menu" type="button">Menu</button>
        </div>
        <p class="reel-note">${esc(this.note || (film ? "" : tr("Ce navigateur ne sait pas filmer : garde plutôt la partie (.json), elle se rejoue dans Panache.", "This browser can't record video: keep the match (.json) instead, it replays in Panache.")))}</p>`;
    }
    this.ui.querySelectorAll<HTMLButtonElement>("[data-a]").forEach((b) =>
      b.addEventListener("click", () => {
        const a = b.dataset.a;
        sfx.play("click", 0.5);
        if (a === "play") this.start(false);
        else if (a === "film") this.start(true);
        else if (a === "skip") this.skip();
        else if (a === "share") void this.share();
        else if (a === "json") download(new Blob([encodeRecord(this.record)], { type: "application/json" }), recordName(this.record.map, this.record.created));
        else if (a === "menu") this.opts.onMenu();
      })
    );
  }

  /** Share the film (a tap: the share sheet needs one), else download it. */
  private async share(): Promise<void> {
    const f = this.made;
    if (!f) return;
    const nav = navigator as Navigator & { canShare?(d: ShareData): boolean };
    if (typeof nav.share === "function" && nav.canShare?.({ files: [f] })) {
      try {
        await nav.share({ files: [f], title: "Panache", text: tr(`${mapById(this.record.map).name} : les temps forts`, `${mapById(this.record.map).name}: the highlights`) });
        return;
      } catch (e) {
        if ((e as Error)?.name === "AbortError") return; // (the player closed the sheet)
      }
    }
    download(f, f.name);
  }

  // ------------------------------------------------------------ drawing ---

  /** Every frame, right after the 3D view is drawn. */
  draw(view: HTMLCanvasElement, overlay: HTMLCanvasElement): void {
    const ctx = this.ctx;
    const W = this.cv.width;
    const H = this.cv.height;
    const s = this.steps[this.at];
    const now = performance.now();
    const k = W / Math.max(1, innerWidth);
    if (!s || s.kind === "title") return this.card(this.titleCard(), now, k);
    if (s.kind === "card") return this.card({ text: s.clip.card }, now, k, now - this.stepAt);
    if (s.kind === "fin") return this.card({ text: tr("Fin", "The End"), sub: this.resultLine(), big: true }, now, k, now - this.stepAt);
    ctx.drawImage(view, 0, 0, W, H);
    ctx.drawImage(overlay, 0, 0, W, H);
    this.filmLook(now, 0.42);
    // letterbox, the moment's line in the bottom bar
    const bar = Math.round(Math.min(H * 0.07, W * 0.09));
    ctx.fillStyle = "#050302";
    ctx.fillRect(0, 0, W, bar);
    ctx.fillRect(0, H - bar, W, bar);
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.fillStyle = GOLD;
    ctx.font = `600 ${Math.round(bar * 0.34)}px ${SERIF}`;
    ctx.fillText("PANACHE", Math.round(bar * 0.5), bar / 2);
    ctx.textAlign = "right";
    ctx.fillText(fmtTime((this.scene?.tick ?? 0) / TICK_RATE), W - Math.round(bar * 0.5), bar / 2);
    ctx.textAlign = "center";
    ctx.fillStyle = IVORY;
    ctx.font = `italic ${Math.round(bar * 0.42)}px ${SERIF}`;
    ctx.fillText(fit(ctx, s.clip.card, W - bar), W / 2, H - bar / 2);
  }

  private titleCard(): CardText {
    const d = new Date(this.record.created);
    const day = isNaN(d.getTime()) ? "" : d.toLocaleDateString(tr("fr-FR", "en-GB"), { day: "numeric", month: "long", year: "numeric" });
    return { kick: tr("Panache présente", "Panache presents"), text: tr("Les temps forts", "The Highlights"), sub: [mapById(this.record.map).name, day].filter(Boolean).join(" · ") };
  }

  /** « Victoire en 7:42 contre IA Rush (Normal) ». */
  private resultLine(): string {
    const r = this.record;
    const secs = (r.end?.tick ?? r.tick) / TICK_RATE;
    const p = r.played;
    if (!p)
      return r.end?.winner
        ? tr(`Victoire ${r.end.winner === "blue" ? "bleue" : "rouge"} en ${fmtTime(secs)}`, `${r.end.winner === "blue" ? "Blue" : "Red"} victory in ${fmtTime(secs)}`)
        : tr(`Match nul · ${fmtTime(secs)}`, `Draw · ${fmtTime(secs)}`);
    const head =
      p.result === "win"
        ? tr(`Victoire en ${fmtTime(secs)}`, `Victory in ${fmtTime(secs)}`)
        : p.result === "loss"
          ? tr(`Défaite en ${fmtTime(secs)}`, `Defeat in ${fmtTime(secs)}`)
          : tr(`Match nul · ${fmtTime(secs)}`, `Draw · ${fmtTime(secs)}`);
    return tr(`${head} contre ${p.against}`, `${head} vs ${p.against}`);
  }

  /** An intertitle: the black card in its gold frame, the fleurons, the line (fading in over `age` ms). */
  private card(c: CardText, now: number, k: number, age = 1000): void {
    const ctx = this.ctx;
    const W = this.cv.width;
    const H = this.cv.height;
    const vmin = Math.min(W, H) / 100;
    const g = ctx.createRadialGradient(W / 2, H * 0.45, 0, W / 2, H * 0.45, Math.max(W, H) * 0.7);
    g.addColorStop(0, "#1a140c");
    g.addColorStop(0.8, "#070502");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    // the frame: gold line, a dark gap, a faint ivory line inside
    const m = Math.max(4.5 * vmin, 14 * k);
    ctx.strokeStyle = GOLD;
    ctx.lineWidth = 1.5 * k;
    ctx.strokeRect(m, m, W - 2 * m, H - 2 * m);
    ctx.strokeStyle = "rgba(239, 227, 196, 0.55)";
    ctx.lineWidth = 1 * k;
    ctx.strokeRect(m + 6 * k, m + 6 * k, W - 2 * m - 12 * k, H - 2 * m - 12 * k);
    const orn = clamp(18 * vmin, 64 * k, 150 * k);
    for (const [fx, fy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]] as const)
      drawShape(ctx, ORNAMENT, fx > 0 ? m - k : W - m + k, fy > 0 ? m - k : H - m + k, orn, fx, fy, GOLD);
    // (the card's flicker in: as title.css fl-card-in)
    const a = age < 450 ? [0, 0.6, 0.25, 1][Math.min(3, Math.floor(age / 120))]! : 1;
    ctx.globalAlpha = a;
    const size = c.big ? clamp(11 * vmin, 34 * k, 96 * k) : clamp(6.6 * vmin, 24 * k, 60 * k);
    ctx.font = `italic ${Math.round(size)}px ${SERIF}`;
    const lines = wrap(ctx, c.text, Math.min(W - 2 * m - 2 * orn * 0.6, size * 14));
    const lh = size * 1.25;
    const fleur = clamp(30 * vmin, 110 * k, 220 * k);
    const subSize = Math.round(size * 0.42);
    const kickSize = Math.round(size * 0.36);
    const block = lines.length * lh + (c.sub ? subSize * 2.2 : 0) + (c.kick ? kickSize * 2.2 : 0) + fleur * 0.4;
    // (with the buttons up under it, the card's words sit higher: a phone on its side has little height to share)
    const cy = this.running ? H / 2 : H * (H < W * 0.6 ? 0.33 : 0.42);
    let y = cy - block / 2;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    if (c.kick) {
      ctx.fillStyle = GOLD;
      ctx.font = `600 ${kickSize}px ${SERIF}`;
      ctx.fillText(c.kick.toUpperCase(), W / 2, y + kickSize / 2);
      y += kickSize * 2.2;
    }
    drawShape(ctx, FLEURON, W / 2 - fleur / 2, y - fleur * 0.1, fleur, 1, 1, GOLD);
    y += fleur * 0.2;
    ctx.fillStyle = IVORY;
    ctx.font = `italic ${Math.round(size)}px ${SERIF}`;
    for (const line of lines) {
      ctx.fillText(line, W / 2, y + lh / 2);
      y += lh;
    }
    drawShape(ctx, FLEURON, W / 2 - fleur / 2, y + fleur * 0.02, fleur, 1, 1, GOLD);
    y += fleur * 0.2;
    if (c.sub) {
      ctx.fillStyle = GOLD;
      ctx.font = `italic ${subSize}px ${SERIF}`;
      for (const line of wrap(ctx, c.sub, W - 2 * m - 2 * orn * 0.5)) {
        y += subSize * 1.3;
        ctx.fillText(line, W / 2, y);
      }
    }
    ctx.globalAlpha = 1;
    this.filmLook(now, 0);
  }

  /** The old film over the frame: a sepia wash, flicker, grain, now and then a scratch, the vignette. */
  private filmLook(now: number, sepia: number): void {
    const ctx = this.ctx;
    const W = this.cv.width;
    const H = this.cv.height;
    ctx.save();
    if (sepia > 0) {
      ctx.globalCompositeOperation = "color";
      ctx.fillStyle = `rgba(150, 106, 58, ${sepia})`;
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = "source-over";
    }
    const still = this.reduced;
    const r = still ? 0.5 : hash(Math.floor(now / 42));
    ctx.fillStyle = `rgba(0, 0, 0, ${0.02 + 0.05 * r})`;
    ctx.fillRect(0, 0, W, H);
    const grain = (this.grain ??= noise(160));
    const pat = ctx.createPattern(grain, "repeat");
    if (pat) {
      ctx.globalAlpha = 0.09;
      ctx.translate(Math.floor(r * 160), Math.floor(hash(r * 977) * 160));
      ctx.fillStyle = pat;
      ctx.fillRect(-160, -160, W + 320, H + 320);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
    }
    if (!still && r > 0.82) {
      ctx.strokeStyle = "rgba(240, 230, 200, 0.22)";
      ctx.lineWidth = 1;
      const x = hash(r * 31) * W;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x + (hash(r * 7) - 0.5) * 12, H);
      ctx.stroke();
    }
    const v = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.hypot(W, H) * 0.56);
    v.addColorStop(0, "rgba(0,0,0,0)");
    v.addColorStop(1, "rgba(0,0,0,0.6)");
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }
}

interface CardText {
  kick?: string;
  text: string;
  sub?: string;
  big?: boolean;
}

// ------------------------------------------------------------------- film ---

/** One recording of the reel's canvas (and the game's sound). */
class Film {
  private chunks: Blob[] = [];
  /** Recorded so far, pauses left out (ms). */
  private took = 0;
  private since = performance.now();
  private done: Promise<Blob | null>;
  private settle!: (b: Blob | null) => void;

  private constructor(private rec: MediaRecorder, readonly type: string, private audio: { stop(): void } | null) {
    this.done = new Promise((r) => (this.settle = r));
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this.chunks.push(e.data);
    };
    rec.onstop = () => {
      this.audio?.stop();
      this.settle(this.chunks.length ? new Blob(this.chunks, { type: this.type.split(";")[0] }) : null);
    };
    rec.onerror = () => {
      this.audio?.stop();
      this.settle(null);
    };
  }

  static start(canvas: HTMLCanvasElement): Film | null {
    if (!canFilm()) return null;
    try {
      const stream = canvas.captureStream(30);
      const audio = sfx.capture();
      if (audio) stream.addTrack(audio.track);
      const type = pickVideoType((t) => MediaRecorder.isTypeSupported(t), !!audio) ?? pickVideoType((t) => MediaRecorder.isTypeSupported(t), false)!;
      const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: FILM_BPS, audioBitsPerSecond: 96_000 });
      const film = new Film(rec, type, audio);
      rec.start(500);
      return film;
    } catch (e) {
      console.warn("film:", e);
      return null;
    }
  }

  get ms(): number {
    return this.took + (this.rec.state === "recording" ? performance.now() - this.since : 0);
  }

  pause(): void {
    if (this.rec.state !== "recording" || typeof this.rec.pause !== "function") return;
    this.took += performance.now() - this.since;
    this.rec.pause();
  }

  resume(): void {
    if (this.rec.state !== "paused") return;
    this.since = performance.now();
    this.rec.resume();
  }

  stop(): Promise<Blob | null> {
    if (this.rec.state !== "inactive") this.rec.stop();
    return this.done;
  }

  discard(): void {
    this.chunks = [];
    if (this.rec.state !== "inactive") this.rec.stop();
  }
}

function download(blob: Blob, name: string): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
}

// --------------------------------------------------------------- shapes ---

/** An SVG of title.ts's ornaments as canvas paths: its strokes (with their widths) and its dots. */
interface Shape {
  w: number;
  h: number;
  paths: { p: Path2D; w: number }[];
  dots: { x: number; y: number; r: number }[];
}

function shapeOf(svg: string): Shape {
  const vb = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg);
  return {
    w: Number(vb?.[1] ?? 100),
    h: Number(vb?.[2] ?? 100),
    paths: [...svg.matchAll(/<path d="([^"]+)" stroke-width="([\d.]+)"/g)].map((m) => ({ p: new Path2D(m[1]), w: Number(m[2]) })),
    dots: [...svg.matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"/g)].map((m) => ({ x: Number(m[1]), y: Number(m[2]), r: Number(m[3]) }))
  };
}

const ORNAMENT = typeof Path2D === "function" ? shapeOf(ornament) : null;
const FLEURON = typeof Path2D === "function" ? shapeOf(fleuron) : null;

/** Draw a shape `size` px wide from (x, y), mirrored by fx / fy (-1) as the CSS corners are. */
function drawShape(ctx: CanvasRenderingContext2D, sh: Shape | null, x: number, y: number, size: number, fx: 1 | -1, fy: 1 | -1, color: string): void {
  if (!sh) return;
  const k = size / sh.w;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(k * fx, k * fy);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineCap = "round";
  for (const p of sh.paths) {
    ctx.lineWidth = p.w;
    ctx.stroke(p.p);
  }
  for (const d of sh.dots) {
    ctx.beginPath();
    ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// ---------------------------------------------------------------- bits ---

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
/** A steady pseudo-random number in [0, 1) for `n` (the flicker, the grain's jitter). */
const hash = (n: number) => {
  const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
};

/** Words to lines no wider than `max`. */
function wrap(ctx: CanvasRenderingContext2D, text: string, max: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(next).width > max) {
      out.push(line);
      line = word;
    } else line = next;
  }
  if (line) out.push(line);
  return out;
}

/** The text, shortened with an ellipsis to fit `max`. */
function fit(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 4 && ctx.measureText(`${t}…`).width > max) t = t.slice(0, -1);
  return `${t}…`;
}

/** A square of grey grain, drawn faintly over the frame. */
function noise(n: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = c.height = n;
  const g = c.getContext("2d")!;
  const img = g.createImageData(n, n);
  for (let i = 0; i < n * n; i++) {
    const v = Math.random() * 255;
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = Math.random() < 0.5 ? 255 : 0;
  }
  g.putImageData(img, 0, 0);
  return c;
}
