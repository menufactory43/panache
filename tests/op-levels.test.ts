import { describe, expect, it } from "vitest";
import { createMapWorld } from "../src/sim/maps";
import { CAMPAIGN, OP_LEVELS, TRIALS, opAiState, shiftDifficulty } from "../src/sim/ops";
import { incomeOf, sideDmg } from "../src/sim/rules";
import { applyResult, emptyCareer, opCleared, opUnlocked, type MatchResult } from "../src/game/career";

const first = CAMPAIGN[0]!;
const second = CAMPAIGN[1]!;
const won = (level?: "recrue" | "veteran"): MatchResult => ({
  kind: "op", mapId: first.map, difficulty: "normal", won: true, secs: 200, buildingsLost: 0, medals: [], mutators: [], daily: null,
  op: { id: first.id, stars: 7, ...(level ? { level } : {}) }
});

describe("Campaign levels", () => {
  it("moves the difficulty a notch, staying put at the ends", () => {
    expect(shiftDifficulty("normal", -1)).toBe("easy");
    expect(shiftDifficulty("easy", -1)).toBe("easy");
    expect(shiftDifficulty("normal", 1)).toBe("hard");
    expect(shiftDifficulty("hard", 1)).toBe("hard");
  });

  it("leaves Normal exactly as tuned", () => {
    const a = createMapWorld(first.map, { op: first.id, seed: 3 });
    const b = createMapWorld(first.map, { op: first.id, seed: 3, opLevel: "normal" });
    expect(a.ops!.level).toBeUndefined();
    expect(b.ops!.level).toBeUndefined();
    expect(JSON.stringify(b.rules)).toBe(JSON.stringify(a.rules));
    expect(sideDmg(a, "red")).toBe(1);
  });

  it("Recrue: more coal for the player, a weaker enemy; Vétéran the other way", () => {
    const base = createMapWorld(first.map, { op: first.id, seed: 3 });
    const easy = createMapWorld(first.map, { op: first.id, seed: 3, opLevel: "recrue" });
    const hard = createMapWorld(first.map, { op: first.id, seed: 3, opLevel: "veteran" });
    expect(easy.ops!.level).toBe("recrue");
    expect(incomeOf(easy, "blue")).toBeCloseTo(incomeOf(base, "blue") * OP_LEVELS.recrue.playerIncome);
    expect(incomeOf(hard, "blue")).toBeCloseTo(incomeOf(base, "blue") * OP_LEVELS.veteran.playerIncome);
    expect(sideDmg(easy, "red")).toBe(OP_LEVELS.recrue.enemyDmg);
    expect(sideDmg(easy, "blue")).toBe(1);
    expect(sideDmg(hard, "red")).toBe(OP_LEVELS.veteran.enemyDmg);
    for (const op of CAMPAIGN) {
      if (!op.ai || op.ai === "survival") continue;
      expect(opAiState(op, 1, "recrue")!.difficulty).toBe(shiftDifficulty(op.ai.difficulty, -1));
      expect(opAiState(op, 1, "veteran")!.difficulty).toBe(shiftDifficulty(op.ai.difficulty, 1));
    }
  });

  it("never touches the Trials", () => {
    const t = TRIALS.find((o) => o.ai && o.ai !== "survival")!;
    const w = createMapWorld(t.map, { op: t.id, seed: 3, opLevel: "recrue" });
    expect(w.ops!.level).toBeUndefined();
    expect(sideDmg(w, "red")).toBe(1);
    if (t.ai && t.ai !== "survival") expect(opAiState(t, 1, "recrue")!.difficulty).toBe(t.ai.difficulty);
  });

  it("stars only count on Normal, but any win opens the next mission", () => {
    for (const level of ["recrue", "veteran"] as const) {
      const { career, s } = applyResult(emptyCareer(), won(level));
      expect(career.ops[first.id]!.stars).toBe(0);
      expect(career.ops[first.id]!.bestSecs).toBeNull();
      expect(opCleared(career.ops[first.id])).toBe(true);
      expect(opUnlocked(career, second.id)).toBe(true);
      expect(s.op!.firstClear).toBe(true);
      // then Normal still earns all three
      const after = applyResult(career, won()).career;
      expect(after.ops[first.id]!.stars).toBe(7);
    }
    expect(applyResult(emptyCareer(), won()).career.ops[first.id]!.stars).toBe(7);
  });
});
