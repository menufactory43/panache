/**
 * "New version ready" on the home screen.
 *
 * The service worker (vite-plugin-pwa, autoUpdate) precaches each build and
 * serves the game from that cache, so a deploy only showed up on the launch
 * AFTER the one that downloaded it, and an installed app resumed from the
 * background never looked for one. Now the page asks for a new build on
 * launch, whenever it comes back to the foreground and every half hour; the
 * new worker activates at once and claims the open page, and the menu shows a
 * pill whose Update button reloads into the new build. A build that lands
 * mid-match is never pushed on the player: every Menu button reloads, and the
 * next page runs it.
 * Engine-free; the browser surface is injectable for tests.
 */

import { fullscreen } from "./fullscreen";

/** While the page is open, ask for a new build this often… */
const CHECK_EVERY_MS = 30 * 60_000;
/** …and when the app comes back to the foreground, if the last ask was longer ago than this. */
const RECHECK_MS = 60_000;

export interface UpdateEnv {
  /** navigator.serviceWorker, or null where there is none (nothing is cached then). */
  sw: {
    readonly controller: unknown;
    addEventListener(type: "controllerchange", fn: () => void): void;
    getRegistration(): Promise<{ update(): Promise<unknown> } | undefined>;
  } | null;
  doc: {
    readonly visibilityState: DocumentVisibilityState;
    addEventListener(type: "visibilitychange", fn: () => void): void;
  };
  every(fn: () => void, ms: number): void;
  now(): number;
}

function browserEnv(): UpdateEnv {
  return {
    sw: "serviceWorker" in navigator ? navigator.serviceWorker : null,
    doc: document,
    every: (fn, ms) => void window.setInterval(fn, ms),
    now: () => performance.now()
  };
}

export class AppUpdate {
  /** A newer build has taken over this page: a reload runs it. */
  ready = false;
  private listeners = new Set<() => void>();
  private lastCheck = -Infinity;

  constructor(private env: () => UpdateEnv = browserEnv) {}

  /** On page load: watch for a new build taking over, and keep asking the server for one. */
  watch(): void {
    const env = this.env();
    const sw = env.sw;
    if (!sw) return;
    // a page the worker didn't serve (first visit, hard reload) came from the
    // network and is already current: the worker claiming it is no update
    let controlled = !!sw.controller;
    sw.addEventListener("controllerchange", () => {
      if (controlled) this.found();
      controlled = true;
    });
    env.doc.addEventListener("visibilitychange", () => this.check());
    env.every(() => this.check(), CHECK_EVERY_MS);
    this.check();
  }

  /** Ask the server for a newer worker (not while hidden, nor twice in a minute). */
  check(): void {
    const env = this.env();
    if (!env.sw || env.doc.visibilityState !== "visible") return;
    const t = env.now();
    if (t - this.lastCheck < RECHECK_MS) return;
    this.lastCheck = t;
    env.sw
      .getRegistration()
      .then((r) => r?.update())
      .catch(() => {
        /* offline or the server is down: the next check tries again */
      });
  }

  /** Call fn when a new build is ready (straight away if one already is); returns an unsubscribe. */
  onReady(fn: () => void): () => void {
    if (this.ready) fn();
    else this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  private found(): void {
    if (this.ready) return;
    this.ready = true;
    for (const fn of [...this.listeners]) fn();
    this.listeners.clear();
  }
}

/** The app's one update watcher. */
export const appUpdate = new AppUpdate();

/** The menu's "New version ready · Update" pill, shown once a new build is ready; returns an unmount. */
export function mountUpdatePill(menu: HTMLElement, update: AppUpdate = appUpdate): () => void {
  const pill = document.createElement("div");
  pill.className = "update-pill";
  pill.setAttribute("role", "status");
  pill.hidden = true;
  pill.innerHTML = `<span class="up-t"><b>✨ Nouvelle version prête</b><span>Touche Mettre à jour pour l'installer</span></span><button class="up-go">Mettre à jour ↻</button>`;
  menu.appendChild(pill);
  const btn = pill.querySelector<HTMLButtonElement>(".up-go")!;
  btn.addEventListener("click", () => {
    btn.disabled = true;
    btn.textContent = "Mise à jour…";
    fullscreen.reload();
  });
  return update.onReady(() => {
    pill.hidden = false;
    menu.classList.add("has-update"); // (portrait: the menu column makes room under it)
  });
}
