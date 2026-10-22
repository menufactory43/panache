/**
 * The relay's play counters (relay/src/stats.ts, pure: the Stats Durable
 * Object only adds them up): which events are counted, the day keys, reading
 * a range of days and the clean-up limit.
 */
import { describe, expect, it } from "vitest";
import { JOURS_GARDES, cleDe, evenementAdmis, jourDe, joursDepuis, limiteMenage, parJour } from "../relay/src/stats";

const DAY = 86_400_000;
const T = Date.UTC(2026, 9, 22, 13, 0, 0);

describe("the relay's play counters", () => {
  it("counts the game's events and nothing else", () => {
    for (const e of ["partie:escarmouche", "fin:campagne:victoire", "fin:survie", "nation:empire", "duel:appaire", "visite:jour", "ecran:duo"]) expect(evenementAdmis(e)).toBe(true);
    for (const e of ["", "partie", "partie:", "Partie:escarmouche", "clic:accueil", "partie:escarmouche:victoire:x", "fin:a", "partie:<script>", null, 3, "nation:" + "x".repeat(40)])
      expect(evenementAdmis(e)).toBe(false);
  });

  it("keys a counter by its UTC day", () => {
    expect(jourDe(T)).toBe("2026-10-22");
    expect(jourDe(Date.UTC(2026, 9, 22, 23, 59))).toBe("2026-10-22");
    expect(cleDe("2026-10-22", "partie:jour")).toBe("2026-10-22|partie:jour");
  });

  it("reads a range of days, oldest first, today included, within bounds", () => {
    expect(joursDepuis(T, 3)).toEqual(["2026-10-20", "2026-10-21", "2026-10-22"]);
    expect(joursDepuis(T, 0)).toEqual(["2026-10-22"]);
    expect(joursDepuis(T, Number.NaN)).toEqual(["2026-10-22"]);
    expect(joursDepuis(T, 10_000)).toHaveLength(120);
  });

  it("groups the stored counters by day", () => {
    const out = parJour([
      ["2026-10-21|partie:escarmouche", 2],
      ["2026-10-22|partie:escarmouche", 5],
      ["2026-10-22|fin:escarmouche:victoire", 3],
      ["garbage", 9]
    ]);
    expect(out).toEqual({ "2026-10-21": { "partie:escarmouche": 2 }, "2026-10-22": { "partie:escarmouche": 5, "fin:escarmouche:victoire": 3 } });
  });

  it("forgets the days beyond the ones kept", () => {
    expect(limiteMenage(T)).toBe(jourDe(T - JOURS_GARDES * DAY));
    expect(cleDe(jourDe(T - (JOURS_GARDES + 1) * DAY), "partie:ia") < `${limiteMenage(T)}|`).toBe(true);
    expect(cleDe(jourDe(T - (JOURS_GARDES - 1) * DAY), "partie:ia") < `${limiteMenage(T)}|`).toBe(false);
  });
});
