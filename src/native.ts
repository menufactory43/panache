/**
 * The iPhone app (Capacitor, capacitor.config.ts): what the game asks of the
 * phone when it runs inside the app rather than in a browser. A buzz under the
 * thumb (the Taptic Engine: iOS Safari has no `navigator.vibrate`), the screen
 * kept on for a match, the status bar hidden. In a browser each falls back to
 * what the page did already.
 */
import { KeepAwake } from "@capacitor-community/keep-awake";
import { Capacitor } from "@capacitor/core";
import { Haptics, ImpactStyle } from "@capacitor/haptics";
import { StatusBar } from "@capacitor/status-bar";

/** True inside the iPhone app. */
export const isApp: boolean = Capacitor.isNativePlatform();

/**
 * A buzz: `ms` (or a pattern, buzz-pause-buzz…) as `navigator.vibrate` takes
 * it. In the app each buzz is one impact of the Taptic Engine, light for a
 * tap, heavier the longer it was meant to last.
 */
export function buzz(pattern: number | number[]): void {
  const beats = typeof pattern === "number" ? [pattern] : pattern;
  if (!isApp) {
    try {
      if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") navigator.vibrate(beats);
    } catch {
      /* haptics unavailable */
    }
    return;
  }
  let at = 0;
  beats.forEach((ms, i) => {
    if (i % 2 === 0) {
      const style = ms >= 18 ? ImpactStyle.Heavy : ms >= 12 ? ImpactStyle.Medium : ImpactStyle.Light;
      setTimeout(() => void Haptics.impact({ style }).catch(() => undefined), at);
    }
    at += ms;
  });
}

/** The app's stand-in for `navigator.wakeLock` (match-focus.ts): the screen stays on until released. */
export const appWakeLock = {
  async request(_type: "screen"): Promise<{ release(): Promise<void> }> {
    await KeepAwake.keepAwake();
    return { release: () => KeepAwake.allowSleep() };
  }
};

/** At boot, in the app: no status bar over the battlefield. */
export function bootApp(): void {
  if (!isApp) return;
  void StatusBar.hide().catch(() => undefined);
}

/** The published game, which the app's shared links point to (a friend without the app plays there). */
export const PUBLISHED_URL = "https://menufactory43.github.io/panache/";

/** The page a shared link is built from: this one, or in the app (capacitor://localhost) the published game. */
export function shareBase(): string {
  return isApp ? PUBLISHED_URL : location.href;
}
