/**
 * Full screen where the platform allows it (Android/desktop; iOS Safari has
 * no Fullscreen API for arbitrary elements — the dvh layout covers it). Never
 * in the iOS app: it is full screen already, and its web view's Fullscreen API
 * only brings Safari's « capacitor://localhost est en plein écran » banner and ✕.
 *
 * Browsers grant full screen only inside a user gesture, and a page reload
 * drops it. Rematch, Retry, ▶ Next op, the Daily rematch and every Menu
 * button reload the page, so a reload made while full screen leaves a note
 * (sessionStorage) and the next page asks again on the first tap or key.
 * Engine-free; the browser surface is injectable for tests.
 */

import { isApp } from "../native";

const KEY = "panache.fullscreen";

export interface FullscreenEnv {
  doc: {
    documentElement: { requestFullscreen?: (opts?: FullscreenOptions) => Promise<void> };
    fullscreenElement?: Element | null;
  };
  win: Pick<Window, "addEventListener" | "removeEventListener">;
  /** sessionStorage, or null where storage is blocked. */
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  reload(): void;
}

function browserEnv(): FullscreenEnv {
  let storage: FullscreenEnv["storage"] = null;
  try {
    storage = window.sessionStorage;
  } catch {
    /* blocked: no restore after a reload */
  }
  const rematch = () => {
    try {
      return storage?.getItem("panache.rematch") ?? null;
    } catch {
      return null;
    }
  };
  const doc: FullscreenEnv["doc"] = isApp ? { documentElement: {}, fullscreenElement: null } : document;
  return { doc, win: window, storage, reload: () => reloadWithoutLink(window.location, rematch()) };
}

/** What a replay's link (main.ts watchLinked) and a practice duel's (?duel=loop|relay, DUEL.md "Dev and test modes") put in the URL. */
const LINK_PARAMS = ["replay", "follow", "duel", "seat", "delay", "loss", "latency", "side"];

/**
 * Reload, leaving a replay's `?replay=` link and a practice duel's `?duel=`
 * parameters behind: their Menu buttons mean the menu. Only such a page
 * loses `side` too: a single-player `?side=red` reloads as it is (its
 * Rematch and Menu stay red). A duel's Rematch (`rematch`, the token just
 * stored, is "duel") keeps the duel's parameters, so a practice rematch is
 * one again.
 */
export function reloadWithoutLink(loc: Pick<Location, "href" | "reload" | "assign">, rematch: string | null = null): void {
  const url = new URL(loc.href);
  const q = url.searchParams;
  if (!q.has("replay") && (!q.has("duel") || rematch === "duel")) return loc.reload();
  for (const k of LINK_PARAMS) q.delete(k);
  loc.assign(url.href);
}

/** Gestures that let a page request full screen (a touch counts on release). */
const GESTURES = ["pointerup", "keydown"] as const;

export class Fullscreen {
  /** Armed to re-request on the next gesture, or a request is in flight. */
  private pending = false;

  constructor(private env: () => FullscreenEnv = browserEnv) {}

  /** Ask for full screen (call inside a user gesture); quietly does nothing where unsupported or declined. */
  async enter(): Promise<void> {
    const { doc } = this.env();
    if (doc.fullscreenElement || !doc.documentElement.requestFullscreen) return;
    this.pending = true;
    try {
      await doc.documentElement.requestFullscreen({ navigationUI: "hide" });
    } catch {
      /* declined or unsupported — fine */
    } finally {
      this.pending = false;
    }
  }

  /** Reload the page (a rematch or the menu), remembering whether the game was full screen, with iOS's audio session back to "auto". */
  reload(): void {
    const env = this.env();
    try {
      if (env.doc.fullscreenElement || this.pending) env.storage?.setItem(KEY, "1");
      else env.storage?.removeItem(KEY);
    } catch {
      /* ignore */
    }
    env.reload();
  }

  /** On page load: if the last page was full screen when it reloaded, ask again on the first tap or key. */
  restoreOnGesture(): void {
    const env = this.env();
    let wanted = false;
    try {
      wanted = env.storage?.getItem(KEY) === "1";
      env.storage?.removeItem(KEY);
    } catch {
      /* ignore */
    }
    if (wanted) this.enterOnGesture();
  }

  /** Ask for full screen on the next tap or key, not this one. Returns a disarm, a no-op once the gesture came. */
  enterOnGesture(): () => void {
    const env = this.env();
    if (!env.doc.documentElement.requestFullscreen) return () => undefined;
    this.pending = true;
    let armed = true;
    const disarm = () => {
      if (!armed) return;
      armed = false;
      for (const type of GESTURES) env.win.removeEventListener(type, onGesture, true);
      this.pending = false;
    };
    const onGesture = (e: Event) => {
      if (e.type === "keydown" && (e as KeyboardEvent).key === "Escape") return; // grants no activation
      disarm(); // (enter() holds pending again while its request is in flight)
      void this.enter();
    };
    // capture: runs before anything the gesture triggers (even a reload)
    for (const type of GESTURES) env.win.addEventListener(type, onGesture, true);
    return disarm;
  }
}

/** The app's one full-screen keeper. */
export const fullscreen = new Fullscreen();
