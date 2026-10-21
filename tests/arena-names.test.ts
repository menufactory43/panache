import { describe, expect, it } from "vitest";
import { buildingKindOf, unitKindOf } from "../src/arena/orders";

describe("arena: agents may name kinds by id, Belle Époque name, or an older name", () => {
  it("units", () => {
    for (const [word, kind] of [
      ["stinger", "stinger"], ["Panhard", "stinger"], ["Dard", "stinger"], ["Stingers", "stinger"],
      ["Faucheux", "flak-crawler"], ["Arpenteur DCA", "flak-crawler"], ["flak", "flak-crawler"],
      ["Canon de 75", "mortar"], ["Canons de 75", "mortar"], ["Mortier", "mortar"],
      ["Éole", "wasp"], ["eole", "wasp"], ["Guêpe", "wasp"], ["Patrie", "scout"],
      ["Escouade d'artificiers", "rocket-squad"], ["Artificiers", "rocket-squad"], ["rocket", "rocket-squad"],
      ["Pioupious", "trooper"], ["Section de chasseurs alpins", "sniper"], ["Équipe de snipers", "sniper"],
      ["Montgolfière", "condor"], ["Condor", "condor"], ["Gargantua", "goliath"], ["Goliath", "goliath"]
    ] as const)
      expect(unitKindOf(word), word).toBe(kind);
    expect(unitKindOf("teapot")).toBeNull();
  });

  it("buildings", () => {
    for (const [word, kind] of [
      ["fab-plant", "fab-plant"], ["Forges", "fab-plant"], ["Usine", "fab-plant"], ["factory", "fab-plant"],
      ["Parc de Chalais-Meudon", "airpad"], ["Meudon", "airpad"], ["Polytechnique", "tech-lab"], ["Labo tech", "tech-lab"],
      ["Halles", "depot"], ["Hotchkiss", "turret"], ["Tourelle", "turret"], ["Batterie Ruggieri", "sam-site"], ["sam", "sam-site"],
      ["Tour TSF", "radar"], ["Manufacture", "assembly-bay"], ["Galerie des Machines", "gantry"], ["Portique", "gantry"], ["GQG", "hq"]
    ] as const)
      expect(buildingKindOf(word), word).toBe(kind);
  });
});
