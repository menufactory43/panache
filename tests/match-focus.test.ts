/**
 * A match on a phone (src/ui/match-focus.ts): the screen wake lock held for
 * the match and asked for again on the way back, and the pause on leaving.
 */
import { describe, expect, it } from "vitest";
import { watchMatchFocus, type FocusEnv } from "../src/ui/match-focus";

function fakeEnv(opts: { wakeLock?: boolean; refuse?: boolean } = {}) {
  const listeners = new Set<() => void>();
  let requests = 0;
  let held = 0;
  const doc = {
    visibilityState: "visible" as DocumentVisibilityState,
    addEventListener: (_t: "visibilitychange", fn: () => void) => void listeners.add(fn),
    removeEventListener: (_t: "visibilitychange", fn: () => void) => void listeners.delete(fn)
  };
  const env: FocusEnv = {
    wakeLock:
      opts.wakeLock === false
        ? null
        : {
            request: () => {
              requests++;
              if (opts.refuse) return Promise.reject(new DOMException("refused", "NotAllowedError"));
              held++;
              return Promise.resolve({ release: () => (held--, Promise.resolve()) });
            }
          },
    doc
  };
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return {
    env,
    show: async (state: DocumentVisibilityState) => {
      doc.visibilityState = state;
      if (state === "hidden") held = 0; // (the browser drops the lock)
      listeners.forEach((fn) => fn());
      await settle();
    },
    settle,
    listeners,
    requests: () => requests,
    held: () => held
  };
}

describe("watchMatchFocus", () => {
  it("holds the screen on, pauses on leaving and asks for the lock again on the way back", async () => {
    const f = fakeEnv();
    let pauses = 0;
    const stop = watchMatchFocus(() => pauses++, f.env);
    await f.settle();
    expect(f.held()).toBe(1);
    await f.show("hidden");
    expect(pauses).toBe(1);
    await f.show("visible");
    expect(pauses).toBe(1);
    expect(f.requests()).toBe(2);
    expect(f.held()).toBe(1);
    stop();
    await f.settle();
    expect(f.held()).toBe(0);
    expect(f.listeners.size).toBe(0);
  });

  it("still pauses where there is no wake lock, or it is refused", async () => {
    for (const opts of [{ wakeLock: false }, { refuse: true }]) {
      const f = fakeEnv(opts);
      let pauses = 0;
      watchMatchFocus(() => pauses++, f.env);
      await f.settle();
      await f.show("hidden");
      await f.show("visible");
      expect(pauses).toBe(1);
      expect(f.held()).toBe(0);
    }
  });

  it("releases a lock granted after the match ended", async () => {
    const f = fakeEnv();
    const stop = watchMatchFocus(() => undefined, f.env);
    stop();
    await f.settle();
    expect(f.held()).toBe(0);
  });
});
