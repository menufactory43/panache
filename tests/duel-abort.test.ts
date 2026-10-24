import { afterEach, describe, expect, it, vi } from "vitest";
import { sfx } from "../src/game/audio";
import { GameScene, type AbortReason } from "../src/game/GameScene";
import { music } from "../src/game/music";
import type { EndOpts } from "../src/ui/hud";

// GameScene.abort (DUEL.md "Hash trail and the end of the match", "Leaving"): a duel that ends with no result
// gets no finale, so nothing else resolves the battle score. The scene is the real class with only what abort reads
// (no renderer: three.js and the HUD stay out), and the music engine is the game's own, watched.

interface Shown {
  winner: unknown;
  opts: EndOpts | undefined;
}

/** A GameScene as far as abort() goes: its gestures, Controller, power panel and HUD, recorded. */
function scene(): { s: GameScene; shown: Shown[] } {
  const shown: Shown[] = [];
  const s = Object.create(GameScene.prototype) as GameScene;
  Object.assign(s, {
    aborted: null,
    ended: false,
    finale: null,
    glide: null,
    boxRect: null,
    powerUi: null,
    gest: { reset: () => undefined },
    ctrl: { clearSelection: () => undefined, placing: null, locked: false },
    hud: { showEnd: (winner: unknown, opts?: EndOpts) => shown.push({ winner, opts }), notify: () => undefined }
  });
  return { s, shown };
}

afterEach(() => vi.restoreAllMocks());

describe("a duel's end with no result", () => {
  for (const reason of ["desync", "left", "lost"] as AbortReason[])
    it(`settles the battle score on its coda, with no sting or jingle ("${reason}")`, () => {
      const finale = vi.spyOn(music, "finale");
      const jingle = vi.spyOn(sfx, "play");
      const { s, shown } = scene();
      s.abort(reason, reason === "desync" ? "{}" : undefined);
      // the end screen says why, and the score resolves as a draw that isn't Robot Love's: tonic and coda, no sting
      expect(shown).toHaveLength(1);
      expect(shown[0]!.winner).toBeNull();
      expect(finale.mock.calls).toEqual([["draw", { love: false }]]);
      expect(jingle).not.toHaveBeenCalled();
      expect([s.over, s.abortReason]).toEqual([true, reason]);
      // once only: a second abort changes nothing
      s.abort("left");
      expect(finale).toHaveBeenCalledTimes(1);
      expect(shown).toHaveLength(1);
    });
});
