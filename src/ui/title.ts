/**
 * Panache's title screen (Belle Époque only, theme.ts BELLE_EPOQUE): the menu's
 * backdrop becomes a living picture in layers (Paris at dusk from Montmartre, a
 * dirigible and a balloon in the sky, a Gargantua striding through the city,
 * a clockwork officer in front) that follow the finger, the mouse or the tilt
 * of the phone, under the flicker and grain of an old film. CSS: title.css.
 *
 * Before the first gesture: « Touchez l'écran » (the sound may only start
 * after one, on iOS). The tap starts the cinématographe:
 *  - the first time ever, the intro film: a leader counting down 3-2-1, then a
 *    silent film (intertitles, three shots with Ken Burns moves) whose last
 *    card, « …et beaucoup de », irises out onto the logo;
 *  - afterwards, a second of projector flicker.
 * Then the logo slams in on a flash, the brass fanfare sounds, the menu music
 * starts on that beat, the logo glides to its place and the menu pops in.
 * « 🎞 Revoir l'intro » in the menu plays the film again.
 *
 * Robots (navigator.webdriver: the smoke test and the Playwright tools tap #play
 * at once), prefers-reduced-motion and a Rematch get the menu at once.
 */
import { sfx } from "../game/audio";
import { leaderBeep, panacheCry, preloadPanacheCry, projectorStart, slamFanfare } from "../game/audio-title";

export const INTRO_SEEN_KEY = "panache.intro.seen";
const ART = "assets/ui/title/";

/** What the player reads on the title screen and in the intro film. */
export const TITLE_TEXT = {
  tap: "Touchez l'écran",
  key: "Appuyez sur une touche",
  skip: "Passer ›",
  presents: "Le Cinématographe présente",
  cards: ["Paris, 1900.", "L’Europe s’arme de vapeur, d’acier et de radium…", "Pour la gagner, il faudra du courage…", "…et beaucoup de"]
} as const;

/** A shot of the film: its picture and a Ken Burns move (view centre x, y in picture fractions, zoom ≥ 1 over "cover"). */
interface Shot {
  src: string;
  from: [number, number, number];
  to: [number, number, number];
}
const SHOTS: Shot[] = [
  { src: "titre-fond", from: [0.62, 0.4, 1.02], to: [0.64, 0.44, 1.22] },
  { src: "intro-marche", from: [0.66, 0.52, 1.14], to: [0.36, 0.42, 1.24] },
  { src: "intro-feu", from: [0.52, 0.42, 1.04], to: [0.36, 0.62, 1.5] }
];

/** The film's running order, in ms from the tap. */
const T = {
  leader: 250,
  beat: 900, // one number of the leader
  card0: 2950,
  shot0: 4550,
  card1: 7450,
  shot1: 9850,
  card2: 12850,
  shot2: 14950,
  flash: 16600, // the 75 fires
  card3: 17950,
  irisOut: 19250,
  slam: 19800
} as const;
const IRIS = 650; // an iris in or out
/** The short projector run (later visits): tap to slam. */
const ROLL_MS = 1150;

export interface TitleHooks {
  /** The logo slammed: start the menu music, on this beat. */
  slam(): void;
  /** The intro replays: the menu music stops. */
  replay(): void;
}

export interface Title {
  /** The menu waits for the slam before its music starts. */
  readonly waiting: boolean;
}

export const ornament = `<svg class="fc-orn" viewBox="0 0 120 120" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-linecap="round">
  <path d="M6 114V30Q6 6 30 6h84" stroke-width="2.4"/>
  <path d="M16 100V38q0-22 22-22h62" stroke-width="1"/>
  <path d="M16 70c0-30 14-46 40-48M70 16c-30 0-46 14-48 40" stroke-width="1.2"/>
  <path d="M30 30c10-10 26-6 24 6c-2 9-14 9-14 2c0-5 6-6 8-3" stroke-width="1.6"/>
  <path d="M40 22c10-8 22-8 30-2M22 40c-8 10-8 22-2 30" stroke-width="1"/>
  <circle cx="30" cy="30" r="2.6" fill="currentColor" stroke="none"/>
  <circle cx="84" cy="11" r="1.6" fill="currentColor" stroke="none"/><circle cx="11" cy="84" r="1.6" fill="currentColor" stroke="none"/>
</g></svg>`;
export const fleuron = `<svg class="fc-fleur" viewBox="0 0 160 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-linecap="round">
  <path d="M4 12h52M104 12h52" stroke-width="1"/>
  <path d="M80 4c-6 0-10 4-10 8s4 8 10 8s10-4 10-8s-4-8-10-8z" stroke-width="1.2"/>
  <path d="M70 12c-6-8-14-8-16 0c-2 6 6 8 8 3M90 12c6-8 14-8 16 0c2 6-6 8-8 3" stroke-width="1.2"/>
  <circle cx="80" cy="12" r="2.2" fill="currentColor" stroke="none"/>
</g></svg>`;
/** The old-film look: sepia wash, grain, flicker, scratches, dust, vignette. */
export const FILMFX = `<i class="o-sepia"></i><i class="o-grain"></i><i class="o-flick"></i><i class="o-scr s1"></i><i class="o-scr s2"></i><i class="o-dust"></i><i class="o-vig"></i>`;

const img = (name: string, cls: string, k?: number) =>
  `<img class="${cls}" src="${ART}${name}.webp" alt="" draggable="false"${k !== undefined ? ` style="--k:${k}"` : ""} />`;

/**
 * Put the title scene under the menu (in place of the key art) and run the
 * press-start and the cinematic unless `skip` (a Rematch) or a robot / reduced
 * motion asks for the menu at once.
 */
export function mountTitle(menu: HTMLElement, hooks: TitleHooks, skip: boolean): Title {
  const scene = document.createElement("div");
  scene.className = "ttl";
  scene.setAttribute("aria-hidden", "true");
  scene.innerHTML = `
    <div class="ttl-par">
      <div class="ttl-l" style="--k:.12"><div class="ttl-fond" style="background-image:url(${ART}titre-fond.webp)"></div></div>
      <div class="ttl-l" style="--k:.22">${img("titre-montgolfiere", "ttl-ballon")}${img("titre-dirigeable", "ttl-zep")}</div>
      <div class="ttl-l" style="--k:.45"><div class="ttl-garg">${img("titre-gargantua", "")}<i class="pf p1"></i><i class="pf p2"></i><i class="pf p3"></i><i class="pf p4"></i></div></div>
      ${img("titre-heros", "ttl-heros", 1)}
    </div>
    <div class="ttl-shade"></div>
    <div class="ttl-old">${FILMFX}</div>`;
  const old = menu.querySelector(".keyart");
  if (old) old.replaceWith(scene);
  else menu.prepend(scene);
  grain(scene);
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!reduced) animateScene(scene);
  const replayBtn = menu.querySelector<HTMLButtonElement>("#replay-intro");
  if (skip || reduced || navigator.webdriver === true) {
    replayBtn?.remove(); // (no film for a robot or reduced motion: no replay either)
    return { waiting: false };
  }

  const over = document.createElement("div");
  over.className = "ttl-over";
  const touch = navigator.maxTouchPoints > 0 || matchMedia("(pointer: coarse)").matches;
  over.innerHTML = `
    <div class="ttl-presents">${TITLE_TEXT.presents}</div>
    <div class="ttl-press"><svg viewBox="0 0 40 16" aria-hidden="true"><path d="M2 8h22c6 0 8-6 3-6s-4 6 1 6h10" fill="none" stroke="currentColor" stroke-width="1.2"/></svg><span>${touch ? TITLE_TEXT.tap : TITLE_TEXT.key}</span><svg viewBox="0 0 40 16" aria-hidden="true"><path d="M38 8H16c-6 0-8-6-3-6s4 6-1 6H2" fill="none" stroke="currentColor" stroke-width="1.2"/></svg></div>
    <div class="ttl-film">
      <div class="fl-gate">
        <div class="fl-part fl-leader"><i class="ld-sweep"></i><i class="ld-ring r1"></i><i class="ld-ring r2"></i><i class="ld-h"></i><i class="ld-v"></i><b class="ld-n"></b></div>
        ${TITLE_TEXT.cards
          .map(
            (t, i) =>
              `<div class="fl-part fl-card c${i}"><div class="fc-frame"><i class="fc-c tl">${ornament}</i><i class="fc-c tr">${ornament}</i><i class="fc-c bl">${ornament}</i><i class="fc-c br">${ornament}</i>${fleuron}<p>${t}</p>${fleuron}</div></div>`
          )
          .join("")}
        ${SHOTS.map((s, i) => `<div class="fl-part fl-shot s${i}"><img class="fl-pic" src="" data-src="${ART}${s.src}.webp" alt="" draggable="false" />${i === 0 ? img("titre-dirigeable", "fl-zep") : ""}<i class="fl-muzzle"></i></div>`).join("")}
      </div>
      <div class="fl-fx">${FILMFX}</div>
      <button class="fl-skip" type="button">${TITLE_TEXT.skip}</button>
    </div>
    <div class="ttl-leak"></div>
    <div class="ttl-flash"></div>
    <div class="ttl-logo"><b>PANACHE</b></div>`;
  menu.appendChild(over);
  grain(over);

  const seen = (() => {
    try {
      return localStorage.getItem(INTRO_SEEN_KEY) === "1";
    } catch {
      return false;
    }
  })();
  const film = over.querySelector<HTMLElement>(".ttl-film")!;
  const parts = [...film.querySelectorAll<HTMLElement>(".fl-part")];
  const leader = film.querySelector<HTMLElement>(".fl-leader")!;
  const cards = [...film.querySelectorAll<HTMLElement>(".fl-card")];
  const shots = [...film.querySelectorAll<HTMLElement>(".fl-shot")];
  const logo = over.querySelector<HTMLElement>(".ttl-logo")!;
  const h1 = menu.querySelector<HTMLElement>(".logo")!;
  /** The film's pictures, fetched while the press-start shows. */
  const loadShots = () => {
    for (const p of film.querySelectorAll<HTMLImageElement>(".fl-pic")) if (!p.getAttribute("src")) p.src = p.dataset.src!;
  };

  let timers: number[] = [];
  const at = (ms: number, fn: () => void) => timers.push(window.setTimeout(fn, ms));
  const clearTimers = () => {
    for (const t of timers) clearTimeout(t);
    timers = [];
  };
  let stopProjector: () => void = () => undefined;
  let phase: "wait" | "film" | "roll" | "slam" | "menu" = "wait";
  let filmStart = 0;
  const state = (s: string) => {
    menu.classList.remove("ttl-wait", "ttl-cine", "ttl-roll", "ttl-slam", "ttl-in");
    if (s) menu.classList.add(s);
  };
  /** Restart a one-shot CSS animation hung on a class. */
  const kick = (el: Element, cls: string) => {
    el.classList.remove(cls);
    void (el as HTMLElement).offsetWidth;
    el.classList.add(cls);
  };
  const show = (el: HTMLElement | null, cls = "") => {
    for (const p of parts) p.classList.remove("on", "iris-in", "iris-out");
    if (!el) return;
    el.classList.add("on");
    if (cls) el.classList.add(cls);
  };

  // ------------------------------------------------------------ the film ---
  const playFilm = () => {
    phase = "film";
    filmStart = performance.now();
    loadShots();
    state("ttl-cine");
    menu.scrollTop = 0;
    stopProjector = projectorStart(0.45);
    kick(over.querySelector(".ttl-leak")!, "go");
    show(null);
    const num = leader.querySelector("b")!;
    for (let i = 0; i < 3; i++)
      at(T.leader + i * T.beat, () => {
        show(leader);
        num.textContent = String(3 - i);
        kick(leader, "tick");
        leaderBeep();
      });
    // the leader's last frame: a white flash, then the first card
    at(T.leader + 3 * T.beat - 120, () => kick(film, "blink"));
    const cardAt = [T.card0, T.card1, T.card2, T.card3];
    const shotAt: [number, number][] = [[T.shot0, T.card1], [T.shot1, T.card2], [T.shot2, T.card3]];
    cardAt.forEach((t, i) => at(t, () => show(cards[i]!, "card-in")));
    shotAt.forEach(([t, end], i) =>
      at(t, () => {
        const shot = shots[i]!;
        show(shot, "iris-in");
        kenBurns(shot, SHOTS[i]!, end - t);
        at(end - t - IRIS, () => shot.classList.add("iris-out"));
      })
    );
    at(T.flash, () => {
      kick(shots[2]!, "fire");
      sfx.play("cannon", 0.55, 0.8);
    });
    at(T.irisOut, () => cards[3]!.classList.add("iris-out"));
    at(T.slam, slam);
  };

  /** The short run: a second of flicker and frame slips before the logo. */
  const roll = () => {
    phase = "roll";
    state("ttl-roll");
    stopProjector = projectorStart(0.4);
    kick(over.querySelector(".ttl-leak")!, "go");
    at(ROLL_MS, slam);
  };

  // ------------------------------------------------------------ the slam ---
  const slam = () => {
    clearTimers();
    phase = "slam";
    stopProjector();
    show(null);
    state("ttl-slam");
    try {
      localStorage.setItem(INTRO_SEEN_KEY, "1");
    } catch {
      /* ignore */
    }
    kick(over.querySelector(".ttl-flash")!, "go");
    kick(scene.querySelector(".ttl-par")!, "shake");
    logo.getAnimations().forEach((a) => a.cancel());
    kick(logo, "slam");
    slamFanfare();
    panacheCry();
    hooks.slam();
    at(1150, glide);
  };
  /** The logo glides from the middle of the screen to the menu's title while the menu pops in. */
  const glide = () => {
    phase = "menu";
    menu.scrollTop = 0;
    menu.querySelectorAll<HTMLElement>(".menu-inner > *").forEach((el, i) => el.style.setProperty("--i", String(i)));
    state("ttl-in");
    const a = logo.getBoundingClientRect();
    const b = h1.getBoundingClientRect();
    const s = b.width / a.width;
    const dx = b.left + b.width / 2 - (a.left + a.width / 2);
    const dy = b.top + b.height / 2 - (a.top + a.height / 2);
    const done = () => {
      menu.classList.add("ttl-done");
      logo.classList.remove("slam");
      logo.getAnimations().forEach((x) => x.cancel());
    };
    if (b.width > 0 && a.width > 0) {
      const anim = logo.animate([{ transform: "none" }, { transform: `translate(${dx}px, ${dy}px) scale(${s})` }], {
        duration: 750,
        easing: "cubic-bezier(.6,0,.2,1)",
        fill: "forwards"
      });
      anim.onfinish = done;
    } else done();
    at(2400, () => state(""));
  };

  const skipToSlam = () => {
    if (phase !== "film" && phase !== "roll") return;
    clearTimers();
    // a cut to black, then the logo
    show(null);
    at(120, slam);
  };

  // ----------------------------------------------------------- the press ---
  const start = () => {
    sfx.unlock();
    preloadPanacheCry();
    if (seen) roll();
    else playFilm();
  };
  over.addEventListener("click", (e) => {
    if (phase === "wait") {
      e.preventDefault();
      e.stopPropagation();
      start();
    } else if (phase === "film" && performance.now() - filmStart > 1000) skipToSlam();
  });
  film.querySelector(".fl-skip")!.addEventListener("click", (e) => {
    e.stopPropagation();
    skipToSlam();
  });
  const key = (e: KeyboardEvent) => {
    if (!menu.isConnected) return window.removeEventListener("keydown", key, true);
    if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    if (phase === "wait") {
      e.preventDefault();
      start();
    } else if (phase === "film" && (e.key === "Escape" || e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      skipToSlam();
    }
  };
  window.addEventListener("keydown", key, true);
  replayBtn?.addEventListener("click", () => {
    if (phase !== "menu") return;
    sfx.play("click", 0.5);
    hooks.replay();
    menu.classList.remove("ttl-done");
    playFilm();
  });

  state("ttl-wait");
  menu.classList.add("ttl-on");
  if (!seen) {
    // the film's pictures come while the player reads « Touchez l'écran »
    if (document.readyState === "complete") loadShots();
    else window.addEventListener("load", loadShots, { once: true });
  }
  return {
    get waiting() {
      return phase === "wait" || phase === "film" || phase === "roll";
    }
  };
}

/** The film grain's tile (inline: a document-relative URL keeps GitHub Pages subpaths working). */
export function grain(root: HTMLElement): void {
  for (const g of root.querySelectorAll<HTMLElement>(".o-grain")) g.style.backgroundImage = `url(${ART}grain.webp)`;
}

/** Run a shot's Ken Burns move, clamped so the picture always covers the screen. */
function kenBurns(shot: HTMLElement, s: Shot, ms: number): void {
  const pic = shot.querySelector<HTMLElement>(".fl-pic")!;
  const vw = shot.clientWidth || innerWidth;
  const vh = shot.clientHeight || innerHeight;
  // "cover" at zoom 1 (the pictures are 3:2)
  const w = Math.max(vw, vh * 1.5);
  const h = w / 1.5;
  pic.style.width = `${w}px`;
  pic.style.height = `${h}px`;
  const frame = ([fx, fy, z]: [number, number, number]) => {
    const W = w * z;
    const H = h * z;
    const x = Math.min(0, Math.max(vw - W, vw / 2 - fx * W));
    const y = Math.min(0, Math.max(vh - H, vh / 2 - fy * H));
    return `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) scale(${z})`;
  };
  pic.getAnimations().forEach((a) => a.cancel());
  pic.animate([{ transform: frame(s.from) }, { transform: frame(s.to) }], { duration: ms, easing: "cubic-bezier(.35,.1,.45,1)", fill: "both" });
}

/**
 * The scene's parallax while it is on the page: the finger, the mouse or the
 * phone's tilt, else a slow figure of eight. Stops by itself once the menu is
 * gone (a game started).
 */
function animateScene(scene: HTMLElement): void {
  const par = scene.querySelector<HTMLElement>(".ttl-par")!;
  let px = 0;
  let py = 0;
  let tx = 0;
  let ty = 0;
  let last = performance.now();
  let live = true;
  const move = (e: PointerEvent) => {
    tx = (e.clientX / innerWidth) * 2 - 1;
    ty = (e.clientY / innerHeight) * 2 - 1;
  };
  const tilt = (e: DeviceOrientationEvent) => {
    if (e.gamma == null || e.beta == null) return;
    tx = Math.max(-1, Math.min(1, e.gamma / 25));
    ty = Math.max(-1, Math.min(1, (e.beta - 45) / 25));
  };
  window.addEventListener("pointermove", move, { passive: true });
  // (iOS asks for permission to read the tilt: there, the finger and the drift do)
  const DOE = (window as unknown as { DeviceOrientationEvent?: { requestPermission?: unknown } }).DeviceOrientationEvent;
  const useTilt = !!DOE && typeof DOE.requestPermission !== "function" && navigator.maxTouchPoints > 0;
  if (useTilt) window.addEventListener("deviceorientation", tilt, { passive: true });
  const stop = () => {
    live = false;
    window.removeEventListener("pointermove", move);
    if (useTilt) window.removeEventListener("deviceorientation", tilt);
  };
  const frame = (now: number) => {
    if (!live) return;
    if (!scene.isConnected) return stop();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const s = now / 1000;
    const dx = tx + Math.sin(s * 0.29) * 0.4;
    const dy = ty + Math.sin(s * 0.43) * 0.3;
    const k = Math.min(1, dt * 2.5);
    const nx = px + (dx - px) * k;
    const ny = py + (dy - py) * k;
    // (no style write when nothing moved: a still frame costs nothing)
    if (Math.abs(nx - px) > 0.0005 || Math.abs(ny - py) > 0.0005) {
      px = nx;
      py = ny;
      par.style.setProperty("--px", px.toFixed(3));
      par.style.setProperty("--py", py.toFixed(3));
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
