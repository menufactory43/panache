/**
 * How the interface presents the nations (PANACHE-CONCEPTION.md §1.1): crests,
 * names, one-line identities, mechanic summaries, signature units and the end
 * screen's flavour lines. Shared by the menu's nation picker, the HUD pill and
 * the end screens. Render side only: no sim state.
 */
import { ECONOMY, NATIONS, UNITS } from "../sim/balance";
import type { BuildingKind, Nation, NationOrClassic, UnitKind } from "../sim/types";
import { portraitKind } from "../game/three/belle/placeholders";
import { EN, tr } from "../lang";

/** A nation's crest (public/assets/ui/crest-*.webp; document-relative for GitHub Pages subpaths). */
export const crestUrl = (n: Nation): string => `assets/ui/crest-${n}.webp`;

/** The crest as an <img> (Classique: the scale glyph in a span of the same class). */
export function crestImg(n: NationOrClassic, cls = "crest"): string {
  return n === "classique"
    ? `<span class="${cls} crest-classique" aria-hidden="true">⚖</span>`
    : `<img class="${cls}" src="${crestUrl(n)}" alt="" draggable="false"/>`;
}

export interface NationCard {
  /** "La République", "L'Empire de Carbonie". */
  title: string;
  /** §1.1 "En une ligne". */
  line: string;
  /** The mechanics in a few words each. */
  mechanics: string[];
  /** Three units that say what the nation is (first: its line-up's showpiece). */
  signature: UnitKind[];
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** 1.25 → "1,25" (balance numbers as the menu writes them). */
const fr = (x: number): string => dec(Math.round(x * 100) / 100);
/** 1.2 → "1,2" in French, "1.2" in English. */
const dec = (x: number | string): string => (EN ? String(x) : String(x).replace(".", ","));

export const NATION_CARDS: Record<Nation, NationCard> = {
  republique: {
    title: cap(NATIONS.republique.name),
    line: tr("Ingénieurs, aviateurs et savants : rapide, aérienne, électrique, fragile.", "Engineers, aviators and scientists: fast, aerial, electric, fragile."),
    mechanics: tr(
      ["Réseau électrique du GQG et des Tours TSF", "Bâtiments préfabriqués, vite produits", `Radium payé ×${fr(NATIONS.republique.radiumValue / ECONOMY.crystalValue)}`],
      ["Power grid from the GHQ and Wireless Towers", "Prefabricated buildings, built fast", `Radium pays ×${fr(NATIONS.republique.radiumValue / ECONOMY.crystalValue)}`]
    ),
    signature: ["zenith", "jamais-contente", "wasp"]
  },
  empire: {
    title: cap(NATIONS.empire.name),
    line: tr("Charbon, vapeur et acier : lent, blindé, l'artillerie la plus longue.", "Coal, steam and steel: slow, armoured, the longest-ranged artillery."),
    mechanics: tr(
      ["Usines à vapeur : deux unités à la fois", "L'infanterie se retranche", `Charbon extrait +${Math.round((NATIONS.empire.coalRate - 1) * 100)} %`],
      ["Steam factories: two units at a time", "Infantry dig in", `Coal mined +${Math.round((NATIONS.empire.coalRate - 1) * 100)}%`]
    ),
    signature: ["goliath", "mortier-280", "mastodon"]
  }
};

/** The short name ("République", "Empire", "Classique"). */
export const nationShort = (n: NationOrClassic): string => (n === "classique" ? tr("Classique", "Classic") : NATIONS[n].short);

/** A unit's portrait as the menu shows it for a nation (the Empire wears the red set: its burgundy is the closer). */
export const nationIcon = (kind: UnitKind, n: Nation): string =>
  `assets/icons/${n === "empire" ? "red/" : ""}${portraitKind(kind)}.webp`;

/** The HQ's name for alerts: the Empire's is the Citadelle. */
export const hqName = (n: NationOrClassic): string => (n === "empire" ? tr("Citadelle", "Citadel") : tr("GQG", "GHQ"));

/** The end screen's line under the verdict, in the nation's voice. */
export function endLine(n: NationOrClassic, won: boolean, foe: NationOrClassic): string | null {
  if (n === "classique") return null;
  const foeName = foe === "classique" ? tr("l'ennemi", "the enemy") : foe === n ? tr(`l'autre ${nationShort(foe)}`, `the other ${nationShort(foe)}`) : NATIONS[foe].name;
  if (n === "republique")
    return won
      ? tr(`Vive la République ! Les savants ont eu raison de ${foeName}.`, `Long live the Republic! The scientists have bested ${foeName}.`)
      : tr(`Le courant est coupé : ${foeName} l'emporte. Les ingénieurs retournent à leurs plans.`, `The power is cut: ${foeName} wins. The engineers go back to their drawing boards.`);
  return won
    ? tr(`Les chaudières ont parlé : ${foeName} cède devant l'acier de Carbonie.`, `The boilers have spoken: ${foeName} yields to Carbonian steel.`)
    : tr(`Les feux s'éteignent dans les forges : ${foeName} a eu raison de l'Empire.`, `The forge fires die down: ${foeName} has bested the Empire.`);
}

/** Which seat a nation-coloured accent follows (the CSS class on a crest's frame). */
export const nationClass = (n: NationOrClassic): string => `nat-${n}`;

/**
 * The nation's rule a kind's in-game info card adds (PANACHE-CONCEPTION.md
 * §1.2): the Réseau électrique for a République building, the Réseau TSF for
 * its units, the Tranchées for an Empire squad, the Vapeur for its factories.
 */
export function nationRuleNote(kind: UnitKind | BuildingKind, n: NationOrClassic): string | null {
  if (n === "classique") return null;
  const isUnit = kind in UNITS;
  if (n === "republique") {
    const p = NATIONS.republique.power;
    const t = NATIONS.republique.tsf;
    if (!isUnit) {
      if (kind === "hq" || kind === "radar")
        return tr(
          `Source du réseau électrique : alimente les bâtiments à ${kind === "hq" ? p?.hqRadius : p?.towerRadius} cases${kind === "radar" && t ? ` ; Réseau TSF : unités à ${t.radius} cases vitesse ×${String(t.speed).replace(".", ",")}, vision +${t.sight}` : ""}.`,
          `Power grid source: powers buildings within ${kind === "hq" ? p?.hqRadius : p?.towerRadius} tiles${kind === "radar" && t ? `; Wireless Net: units within ${t.radius} tiles get speed ×${t.speed}, vision +${t.sight}` : ""}.`
        );
      return tr(`Hors réseau : à l'arrêt. Doit toucher le cercle d'un GQG (${p?.hqRadius} cases) ou d'une Tour TSF (${p?.towerRadius}).`, `Off the grid: shut down. Must touch the circle of a GHQ (${p?.hqRadius} tiles) or a Wireless Tower (${p?.towerRadius}).`);
    }
    return t ? tr(`Réseau TSF : près d'une Tour TSF ou d'un Zénith, vitesse ×${String(t.speed).replace(".", ",")} et vision +${t.sight}.`, `Wireless Net: near a Wireless Tower or a Zénith, speed ×${t.speed} and vision +${t.sight}.`) : null;
  }
  const e = NATIONS.empire;
  if (isUnit) {
    const u = UNITS[kind as UnitKind];
    if (u.squad && e.trench) return tr(`Se retranche après ${e.trench.still} s immobile : dégâts subis ×${String(e.trench.mult).replace(".", ",")}.`, `Digs in after ${e.trench.still} s standing still: damage taken ×${e.trench.mult}.`);
    return null;
  }
  if (kind === "fab-plant" || kind === "airpad" || kind === "assembly-bay") return tr(`Vapeur : fabrique ${e.parallel} unités à la fois, plus lentement.`, `Steam: builds ${e.parallel} units at a time, more slowly.`);
  if (kind === "turret" && e.trench) return tr(`L'infanterie à ${String(e.trench.redoubtRadius).replace(".", ",")} cases est retranchée aussitôt.`, `Infantry within ${e.trench.redoubtRadius} tiles dig in at once.`);
  return null;
}
