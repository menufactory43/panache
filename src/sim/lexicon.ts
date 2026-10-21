/**
 * French grammar for the Belle Époque names in balance.ts and powers.ts:
 * gender, number and plural of each unit, building and power, so running
 * text agrees ("ta Patrie est détruite", "les Forges sont tombées").
 * Player-visible text only: nothing here is compared, sent or saved.
 */
import type { BuildingKind, PowerKind, UnitKind } from "./types";

export type NamedKind = UnitKind | BuildingKind | PowerKind;

/** Kinds whose French name is feminine (Patrie, Escouade, Section, Montgolfière, Forges, Polytechnique, Halles, Hotchkiss, Batterie, Tour, Manufacture, Galerie, Fée). */
export const FEMININE: ReadonlySet<NamedKind> = new Set<NamedKind>([
  "scout", "trooper", "rocket-squad", "sniper", "condor",
  "fab-plant", "tech-lab", "depot", "turret", "sam-site", "radar", "assembly-bay", "gantry",
  "emp"
]);

/** Kinds whose French name is already plural (les Forges, les Halles). */
export const PLURAL_NOUN: ReadonlySet<NamedKind> = new Set<NamedKind>(["fab-plant", "depot"]);

/**
 * Plurals. Makers' and aviators' names stay invariable, as French does with
 * brands ("deux Panhard", "trois Blériot"); common nouns take their -s.
 */
export const PLURALS: Record<UnitKind | BuildingKind, string> = {
  harvester: "Fardiers",
  scout: "Patries",
  stinger: "Panhard",
  "flak-crawler": "Faucheux",
  mortar: "Canons de 75",
  mastodon: "Creusot",
  lancer: "Hydroglisseurs",
  wasp: "Éole",
  raptor: "Blériot",
  hornet: "Albatros",
  mender: "Pasteur",
  trooper: "Escouades de pioupious",
  "rocket-squad": "Escouades d'artificiers",
  sniper: "Sections de chasseurs alpins",
  condor: "Montgolfières",
  goliath: "Gargantuas",
  hq: "GQG",
  "fab-plant": "Forges",
  airpad: "Parcs de Chalais-Meudon",
  "tech-lab": "Polytechnique",
  depot: "Halles",
  turret: "Hotchkiss",
  "sam-site": "Batteries Ruggieri",
  radar: "Tours TSF",
  "assembly-bay": "Manufactures",
  gantry: "Galeries des Machines"
};

/** Names starting with an aspirated h: no elision ("la Hotchkiss", "les Halles"). */
const ASPIRATED = /^(Hotchkiss|Halles)/;
/** Does the article elide before this word? ("l'Éole", "l'Hydroglisseur", but "la Hotchkiss"). */
export const elides = (word: string): boolean => !ASPIRATED.test(word) && /^[aeiouyéèêàâîôûh]/i.test(word);

export const isFeminine = (k: NamedKind | null | undefined): boolean => !!k && FEMININE.has(k);
export const isPluralNoun = (k: NamedKind | null | undefined): boolean => !!k && PLURAL_NOUN.has(k);

/** An adjective or past participle agreed with the kind: agree("turret", "détruit") = "détruite", agree("fab-plant", "détruit") = "détruites". */
export const agree = (k: NamedKind | null | undefined, word: string): string =>
  `${word}${isFeminine(k) ? "e" : ""}${isPluralNoun(k) ? "s" : ""}`;

/** Definite article with the noun: "le Panhard", "la Patrie", "l'Éole", "les Forges". */
export const theName = (k: NamedKind, name: string): string =>
  isPluralNoun(k) ? `les ${name}` : elides(name) ? `l'${name}` : isFeminine(k) ? `la ${name}` : `le ${name}`;

/** Indefinite article with the noun: "un Panhard", "une Patrie", "des Forges". */
export const aName = (k: NamedKind, name: string): string =>
  isPluralNoun(k) ? `des ${name}` : isFeminine(k) ? `une ${name}` : `un ${name}`;

/** "est" / "sont" for the kind as subject. */
export const isVerb = (k: NamedKind | null | undefined): string => (isPluralNoun(k) ? "sont" : "est");
