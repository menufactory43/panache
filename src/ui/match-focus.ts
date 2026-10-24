/**
 * A match on a phone: the screen stays on, and the game pauses when the app
 * goes to the background.
 *
 * The page stops drawing while hidden, so the battle froze there already, but
 * it came back running, straight into the fighting: now the HUD opens the
 * pause menu as the app leaves (a duel excepted: the friend plays on). The
 * screen wake lock is held for the whole match; the browser drops it when the
 * page is hidden, so it is asked for again on the way back.
 * Engine-free; the browser surface is injectable for tests.
 */

interface WakeSentinel {
  release(): Promise<void>;
}

export interface FocusEnv {
  /** navigator.wakeLock, or null where there is none (or it does nothing). */
  wakeLock: { request(type: "screen"): Promise<WakeSentinel> } | null;
  doc: {
    readonly visibilityState: DocumentVisibilityState;
    addEventListener(type: "visibilitychange", fn: () => void): void;
    removeEventListener(type: "visibilitychange", fn: () => void): void;
  };
}

/** An iOS Home Screen app before 18.4, whose wake lock resolves and does nothing. */
function wakeLockIsDud(nav: { standalone?: unknown; maxTouchPoints?: number }): boolean {
  if (nav.standalone !== true || !nav.maxTouchPoints) return false;
  const it = (globalThis as { Iterator?: { prototype?: { map?: unknown } } }).Iterator;
  return typeof it?.prototype?.map !== "function";
}

function browserEnv(): FocusEnv {
  const nav = navigator as Navigator & { standalone?: boolean };
  return { wakeLock: "wakeLock" in nav && !wakeLockIsDud(nav) ? nav.wakeLock : null, doc: document };
}

/** Keep the screen on for the match and call `onHidden` when the app goes to the background; returns the stop. */
export function watchMatchFocus(onHidden: () => void, env: FocusEnv = browserEnv()): () => void {
  let lock: WakeSentinel | null = null;
  let asking = false;
  let stopped = false;
  const hold = () => {
    if (!env.wakeLock || lock || asking || stopped || env.doc.visibilityState !== "visible") return;
    asking = true;
    let ask: Promise<WakeSentinel>;
    try {
      ask = env.wakeLock.request("screen");
    } catch {
      asking = false;
      return;
    }
    ask.then(
      (s) => {
        asking = false;
        if (stopped || env.doc.visibilityState !== "visible") void s.release().catch(() => undefined);
        else lock = s;
      },
      () => (asking = false) // (refused: low battery, no user gesture yet; the next return to the foreground asks again)
    );
  };
  const change = () => {
    if (env.doc.visibilityState === "visible") return hold();
    lock = null; // (the browser has released it)
    onHidden();
  };
  env.doc.addEventListener("visibilitychange", change);
  hold();
  return () => {
    stopped = true;
    env.doc.removeEventListener("visibilitychange", change);
    void lock?.release().catch(() => undefined);
    lock = null;
  };
}
