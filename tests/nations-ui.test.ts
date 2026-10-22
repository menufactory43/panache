// The nations' interface (WP6): the AI's nation pick, the end screen's crests and line, the network's refusal.
import { describe, expect, it } from "vitest";
import { setupWorld } from "../src/sim/setup";
import { rivalFor } from "../src/game/mode";
import { explainPlacement } from "../src/game/controller";
import { nationHeadHtml, nationLineHtml } from "../src/ui/report";
import { NATION_CARDS, endLine, hqName } from "../src/ui/nations-ui";
import { UNITS, ROSTERS } from "../src/sim/balance";

const world = (nations?: { blue: "republique" | "empire"; red: "republique" | "empire" }) =>
  setupWorld({ map: "riverlands", seed: 7, mutators: [], openers: {}, ...(nations ? { nations } : {}) });

describe("the AI's nation", () => {
  it("is the other one, the player's own, or a roll", () => {
    expect(rivalFor("republique", "opposite")).toBe("empire");
    expect(rivalFor("empire", "opposite")).toBe("republique");
    expect(rivalFor("empire", "same")).toBe("empire");
    expect(rivalFor("republique", "random", () => 0.1)).toBe("republique");
    expect(rivalFor("republique", "random", () => 0.9)).toBe("empire");
  });
});

describe("the nation cards", () => {
  it("show three units each nation fields", () => {
    for (const n of ["republique", "empire"] as const) {
      expect(NATION_CARDS[n].signature).toHaveLength(3);
      for (const k of NATION_CARDS[n].signature) expect(ROSTERS[n].units, `${n} ${UNITS[k].name}`).toContain(k);
    }
  });
});

describe("the end screen", () => {
  it("adds nothing in Classique", () => {
    const w = world();
    expect(nationHeadHtml(w, "blue", false)).toBe("");
    expect(nationLineHtml(w, "blue", "blue", false)).toBe("");
  });
  it("shows both crests and the player's nation's line", () => {
    const w = world({ blue: "republique", red: "empire" });
    const head = nationHeadHtml(w, "blue", false);
    expect(head).toContain("crest-republique.webp");
    expect(head).toContain("crest-empire.webp");
    expect(head.indexOf("crest-republique")).toBeLessThan(head.indexOf("crest-empire"));
    expect(nationLineHtml(w, "blue", "blue", false)).toContain(endLine("republique", true, "empire")!);
    expect(nationLineHtml(w, "blue", "red", false)).toContain(endLine("empire", false, "republique")!);
    expect(nationLineHtml(w, "draw", "blue", false)).toBe("");
    expect(nationLineHtml(w, "blue", "blue", true)).toBe("");
  });
  it("names a mirror's foe as the other one", () => {
    expect(endLine("empire", true, "empire")).toContain("l'autre Empire");
  });
});

describe("alerts and placement", () => {
  it("call the Empire's HQ the Citadelle", () => {
    expect(hqName("empire")).toBe("Citadelle");
    expect(hqName("republique")).toBe("GQG");
  });
  it("say where the network is", () => {
    expect(explainPlacement("Hors du réseau électrique")).toMatch(/GQG ou d'une Tour TSF/);
    expect(explainPlacement("Bloqué")).toBe("Bloqué");
    expect(explainPlacement(null)).toBeNull();
  });
});
