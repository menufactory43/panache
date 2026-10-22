// Every unit's and building's description, read from balance.ts so it never
// drifts from the game, plus hand-written notes on what makes each one
// special: the cards on the vehicles page (vehicles.html) and the 3D models
// page (models.html).
import {
  BUILDINGS, DAMAGE_VS, ECONOMY, GOLIATH, INFANTRY, NATION_BUILDINGS, NATIONS, OBJECTIVES, ROSTERS, TERRAIN, UNITS, ZENITH, shotDamage,
  type ArmedStats, type GoliathWeaponStats
} from "./sim/balance";
import { COUNTERS } from "./game/advisor";
import { portraitKind } from "./game/three/belle/placeholders";
import { displayName, pluralName } from "./sim/lexicon";
import { Terrain, type ArmorClass, type BuildingKind, type Nation, type NationOrClassic, type UnitKind } from "./sim/types";

const fmt = (n: number): string => String(Math.round(n * 100) / 100).replace(".", ",");
const NB = "\u00a0";

export const FEATURES: Record<UnitKind, string[]> = {
  harvester: [
    "Ton économie : il rejoint le gisement de charbon ou de radium le plus proche, remplit sa benne et rapporte le tout au GQG ou aux Halles.",
    "Le radium vaut 1,6× le charbon par chargement : les gisements de radium valent qu'on se batte pour eux.",
    "Lent et non armé ; les raids aériens le chassent en priorité. Bâtis des Halles près des gisements éloignés pour raccourcir le trajet.",
    "Ne laisse aucune épave à récupérer."
  ],
  scout: [
    "Le dirigeable le plus rapide de la carte, avec la plus grande vision.",
    "Non armée : sers-t'en pour trouver la base ennemie, repérer les gisements et guetter les attaques dans le brouillard.",
    "Bon marché et rapide à produire — en perdre une n'est pas grave si elle t'a rapporté du renseignement."
  ],
  stinger: [
    "Automitrailleuse légère, rapide et bon marché, à canon en tourelle — la colonne vertébrale d'une armée en début de partie.",
    "Assez rapide pour raider les Fardiers et distancer les blindés plus lents.",
    "À coût égal, bat Faucheux, Canons de 75 et Hydroglisseurs, mais ne peut pas tirer sur les appareils."
  ],
  "flak-crawler": [
    "La réponse antiaérienne dédiée : des rafales de DCA rapides qui déchiquettent les aéronefs, très efficaces contre les appareils légers.",
    "À coût égal, bat tous les appareils, bombardiers Albatros compris.",
    "Totalement impuissant face aux unités au sol — escorte-le avec des chars."
  ],
  mortar: [
    "Artillerie longue portée : tire plus loin que toute Hotchkiss ou Batterie Ruggieri, l'outil idéal pour percer une base.",
    "Les obus sont de vrais projectiles à effet de zone, visant la position passée de la cible — les unités rapides peuvent les esquiver.",
    "Portée minimale et blindage léger : tout ce qui s'approche le met en pièces."
  ],
  mastodon: [
    "Char super-lourd à double canon, sorti des aciéries du Creusot : de loin le char le plus résistant.",
    "Ses canons frappent plus fort les blindés lourds, et il écrase Panhard, Faucheux et Canons de 75.",
    "Lent et incapable de tirer en l'air — Éole et Hydroglisseurs sont son cauchemar."
  ],
  lancer: [
    "Hydroglisseur : traverse l'eau et les hauts-fonds et ignore le terrain accidenté, ouvrant des routes interdites aux chenillés.",
    "Son arc électrique perce les blindages lourds (1,55×) : c'est le tueur de Creusot.",
    "Le seul char qui peut aussi tirer sur les appareils, avec un effet réduit."
  ],
  wasp: [
    "Aéronef d'attaque à roquettes qui survole tous les obstacles pour frapper les cibles au sol.",
    "À coût égal, bat chars et artillerie — parfait pour harceler Fardiers et Canons de 75.",
    "Tombe vite face aux Faucheux, aux Blériot et aux Batteries Ruggieri."
  ],
  raptor: [
    "Intercepteur de supériorité aérienne : des fusées rapides qui chassent les autres appareils.",
    "Contre les Éole, Albatros et Pasteur.",
    "Ne peut rien attaquer au sol."
  ],
  hornet: [
    "Bombardier lourd blindé qui pilonne unités au sol et bâtiments avec des dégâts de zone.",
    "Ses bombes explosives font 1,35× de dégâts aux structures — idéal pour raser une base.",
    "Les bombes sont des projectiles esquivables, et il lui faut une escorte contre Faucheux, Blériot et Ruggieri."
  ],
  mender: [
    "Aéronef de réparation : un rayon qui soigne une unité ou un bâtiment allié endommagé à portée, un à la fois.",
    "Garde une armée plus longtemps au combat ; l'IA s'en sert comme escorte.",
    "Non armé et peu blindé — Blériot et Faucheux l'abattent facilement."
  ],
  trooper: [
    `Cinq automates fusiliers qui combattent en une escouade : un seul total de PV, et un automate tombe à chaque cinquième perdu — la puissance de feu baisse avec eux.`,
    "L'unité la moins chère capable de tirer sur les appareils, à moitié d'effet. Chaque camp commence avec une escouade.",
    `Traverse bois et terrain accidenté à pleine vitesse, et ne subit que ${Math.round(INFANTRY.woodsCover * 100)} % des dégâts dans les bois (véhicules : ${Math.round(TERRAIN[Terrain.Forest].cover * 100)} %).`,
    `Capture les Relais ${INFANTRY.captureWeight}× plus vite qu'un véhicule et ramasse les caisses de ravitaillement. Ne laisse pas d'épave.`
  ],
  "rocket-squad": [
    `Trois automates à fusées d'épaule : dégâts de canon, ${DAMAGE_VS.cannon.heavy}× contre les blindés lourds — la réponse bon marché aux Creusot.`,
    `Tire aussi sur les appareils (${UNITS["rocket-squad"].airMult}×) : Albatros et Éole paient cher leurs passages à basse altitude.`,
    "Faible contre l'infanterie : pioupious et chasseurs alpins la fauchent."
  ],
  sniper: [
    `Deux tireurs d'élite au fusil Lebel : dégâts de précision, ${Math.round(shotDamage(UNITS.sniper))} par tir et ${DAMAGE_VS.precision.infantry}× contre l'infanterie — un tir abat environ trois automates pioupious.`,
    `Caché dans les bois : l'ennemi ne le voit qu'à moins de ${INFANTRY.concealRadius} cases, sauf pendant ${INFANTRY.concealAfterShot} s après chaque tir.`,
    "Presque inutile contre blindés et bâtiments, et lent à tirer : tiens les véhicules à distance."
  ],
  condor: [
    `Transport : emporte ${UNITS.condor.capacity} escouades d'infanterie au-dessus de l'eau, des rochers et de tout obstacle. Non armé.`,
    `Sélectionne des escouades et touche la Montgolfière pour les embarquer (1 s chacune, une fois arrivées) ; appui long sur la carte pour y voler et les larguer (elle fait du surplace ${INFANTRY.unloadHover} s), ou touche Débarquer.`,
    `Abattue au-dessus de la terre, ses escouades sautent avec au plus ${Math.round(INFANTRY.bailoutHp * 100)} % de PV ; au-dessus de l'eau ou des rochers, elles périssent avec elle.`
  ],
  goliath: [
    "Une machine géante qui marche, et une base mobile : mortiers d'épaule, arc électrique oculaire, canons de bras et mitrailleuses qui touchent aussi les appareils.",
    `Ancre-le (${GOLIATH.anchorTime} s pour s'ancrer, ${GOLIATH.packTime} s pour lever l'ancre) : il reçoit le charbon des Fardiers, forme de l'infanterie et te laisse bâtir des avant-postes à ${GOLIATH.buildRing} cases de lui, n'importe où sur la carte.`,
    `Perd ses armes à mesure qu'il est touché : mortiers sous ${Math.round(GOLIATH.weapons.mortars.lostBelow * 100)} % de PV, arc électrique sous ${Math.round(GOLIATH.weapons.laser.lostBelow * 100)} %, canons sous ${Math.round(GOLIATH.weapons.cannons.lostBelow * 100)} %. Seuls les Pasteur le soignent, et chaque arme redémarre une fois réparée.`,
    `Toujours visible par l'ennemi. Deux Montgolfières vides peuvent le porter ; tant qu'un camp a un Gargantua, perdre son GQG ne fait pas perdre la partie. Chacun coûte ${Math.round(GOLIATH.costStep * 100)} % de plus par Gargantua déjà possédé.`
  ],
  // ---- the nations' units (PANACHE-CONCEPTION.md §1.5) ----
  fourgon: [
    `Le récolteur électrique de la République : rapide (${UNITS.fourgon.speed} contre ${UNITS.harvester.speed} au Fardier), mais une petite cale de ${UNITS.fourgon.cargo ?? ECONOMY.harvesterCapacity} au lieu de ${ECONOMY.harvesterCapacity}.`,
    `Le radium vaut ${fmt(NATIONS.republique.radiumValue)}× le charbon pour la République (${fmt(ECONOMY.crystalValue)}× en Classique) : pousse tes Fourgons vers les gisements du centre.`,
    "Non armé et fragile : garde-le sous la protection d'une Tour TSF ou d'une Bobine d'Arsonval."
  ],
  "jamais-contente": [
    "Le bolide électrique de début de partie, le blindé le plus rapide du jeu : idéal pour raider Fardiers et pièces d'artillerie.",
    `Son arc court perce le blindage (${DAMAGE_VS.laser.heavy}× contre les blindés lourds) : trois Jamais-Contente font fondre un Creusot.`,
    `Blindage léger et ${UNITS["jamais-contente"].hp} PV : les Panhard et les Fusiliers (arc ×${DAMAGE_VS.laser.infantry} contre l'infanterie) la battent. Ne tire pas en l'air.`
  ],
  "de-dion": [
    "L'autocanon antiaérien de la République : un barrage rapide qui déchire Gyroptères, Vulcains et Titans.",
    `Portée ${UNITS["de-dion"].range} : il tient les Gyroptères à distance avant qu'ils ne puissent répondre.`,
    "Totalement impuissant au sol : escorte-le de Jamais-Contente ou d'Hydroglisseurs."
  ],
  branly: [
    `Canon électromagnétique : obus rapides (vitesse ${UNITS.branly.projectileSpeed}) à ${UNITS.branly.range} cases, plus difficiles à esquiver que ceux d'un Canon de 75.`,
    `Portée minimale ${UNITS.branly.minRange} et seulement ${UNITS.branly.hp} PV : tout ce qui l'approche le détruit.`,
    "Perce les défenses impériales de loin ; mais le Mortier de 280 le surclasse en portée."
  ],
  sapeurs: [
    `Trois sapeurs-électriciens à lance à arc : ${DAMAGE_VS.laser.heavy}× contre les blindés lourds — la réponse de la République aux Creusot et au Gargantua.`,
    "Ne tirent pas en l'air, et le Creusot les écrase s'ils le laissent approcher.",
    `Comme toute infanterie : à couvert dans les bois (${Math.round(INFANTRY.woodsCover * 100)} % des dégâts), et capturent les Relais ${INFANTRY.captureWeight}× plus vite.`
  ],
  zenith: [
    "Croiseur aérien et base volante : seuls l'antiaérien et les armes qui touchent l'air peuvent l'atteindre.",
    `Amarre-le (${ZENITH.anchorTime} s ; ${ZENITH.packTime} s pour larguer les amarres) au-dessus d'un sol constructible : il reçoit le charbon, produit ${ZENITH.trains.map((k) => pluralName(k)).join(", ")}, alimente le réseau électrique et te laisse bâtir à ${ZENITH.buildRing} cases de lui.`,
    `Perd ses armes à mesure qu'il est touché : ${(["branly", "arc", "bombs"] as const).map((k) => `${ZENITH.weapons[k].name} sous ${Math.round(ZENITH.weapons[k].lostBelow * 100)}${NB}%`).join(", ")}. Seuls les Pasteur le réparent.`,
    `Toujours visible par l'ennemi. Chacun coûte ${Math.round(ZENITH.costStep * 100)} % de plus par Zénith déjà possédé ; tant qu'il vole, perdre le GQG ne fait pas perdre la partie.`
  ],
  estafette: [
    `L'éclaireur de l'Empire : une motocyclette à vapeur à ${UNITS.estafette.speed} de vitesse et ${UNITS.estafette.sight} cases de vision.`,
    `La moins chère des unités (${UNITS.estafette.cost}) : envoie-la trouver la base ennemie, puis guetter pour le Mortier de 280.`,
    "Reste au sol : l'eau, les falaises et les rochers l'arrêtent. Non armée."
  ],
  "mortier-280": [
    `Pièce de siège : ${UNITS["mortier-280"].range} cases de portée, plus que toute défense (Bobine ${fmt(BUILDINGS.arsonval.range)}, Ruggieri ${fmt(BUILDINGS["sam-site"].range)}) — il démolit une base sans lui laisser riposter.`,
    `Aveugle : il ne voit qu'à ${UNITS["mortier-280"].sight} cases. Il lui faut un guetteur (Estafette, Ballon captif) pour tirer au loin.`,
    `Portée minimale ${UNITS["mortier-280"].minRange}, lent et un obus toutes les ${UNITS["mortier-280"].shotInterval} s : les Jamais-Contente et les Éole le détruisent.`
  ],
  gyroptere: [
    "Autogire d'attaque à vapeur : son canon antichar frappe chars et artillerie par-dessus tous les obstacles.",
    `Blindage moyen et ${UNITS.gyroptere.hp} PV : plus robuste qu'un Éole, mais plus lent.`,
    "Craint la DCA : l'Autocanon De Dion et la Batterie Ruggieri l'abattent. Ne tire pas en l'air."
  ],
  epervier: [
    `Chasseur à vapeur : ses canons (${DAMAGE_VS.cannon.heavy}× contre les blindages lourds) percent Albatros et Zénith.`,
    "Bat les Éole, mais le Blériot, plus rapide et à plus longue portée, garde un léger avantage sur lui.",
    "Ne tire pas au sol."
  ],
  vulcain: [
    `Bombardier blindé (${UNITS.vulcain.hp} PV, blindage lourd) : ses bombes de zone écrasent bases, défenses et colonnes.`,
    `Lent (${UNITS.vulcain.speed}) et désarmé contre l'air : escorte-le d'Éperviers.`,
    "Les Blériot, l'Autocanon De Dion et les Batteries Ruggieri sont ses ennemis."
  ],
  atelier: [
    `Locomobile de réparation : ${UNITS.atelier.heal} PV/s aux véhicules, au Gargantua et aux bâtiments à ${UNITS.atelier.range} cases.`,
    "Ne répare pas les aéronefs : seuls les appareils de la République ont leur Pasteur.",
    `Blindage moyen et ${UNITS.atelier.hp} PV : il suit la colonne au lieu de rester en arrière.`
  ],
  fusiliers: [
    `Cinq automates fusiliers cuirassés (${UNITS.fusiliers.hp} PV) : l'infanterie de ligne de l'Empire. Tirent sol et air (${fmt(UNITS.fusiliers.airMult ?? 1)}× en l'air).`,
    `Se retranchent : immobiles ${NATIONS.empire.trench?.still ?? 3} s, ils ne subissent plus que ${Math.round((NATIONS.empire.trench?.mult ?? 1) * 100)} % des dégâts (à ${NATIONS.empire.trench?.redoubtRadius ?? 0} cases d'une Hotchkiss : aussitôt).`,
    "Battent les Jamais-Contente ; les chasseurs alpins, de plus loin, les déciment."
  ],
  carabiniers: [
    `Deux carabiniers blindés : dégâts de précision, ${DAMAGE_VS.precision.infantry}× contre l'infanterie — ils effacent pioupious et sapeurs.`,
    `Portée ${UNITS.carabiniers.range}, plus courte que les chasseurs alpins (${UNITS.sniper.range}) : ceux-ci les battent.`,
    "Se retranchent comme toute escouade impériale ; presque inutiles contre les blindés."
  ],
  titan: [
    `Dirigeable-cargo cuirassé : emporte ${UNITS.titan.capacity} escouades au-dessus de l'eau et des obstacles. Non armé.`,
    `Blindage lourd et ${UNITS.titan.hp} PV : il survit mieux qu'une Montgolfière à la DCA.`,
    "Deux Titans vides soulèvent un Gargantua et le portent n'importe où sur la carte."
  ]
};

export const GROUPS: { title: string; kinds: UnitKind[] }[] = [
  { title: "Produit au GQG", kinds: ["harvester"] },
  { title: "Forges — véhicules terrestres", kinds: ["stinger", "flak-crawler", "mortar", "mastodon", "lancer"] },
  { title: "Manufacture — infanterie automate", kinds: ["trooper", "rocket-squad", "sniper"] },
  { title: "Parc de Chalais-Meudon — aéronefs", kinds: ["scout", "wasp", "raptor", "hornet", "mender", "condor"] },
  { title: "Galerie des Machines — Gargantua", kinds: ["goliath"] }
];

const TARGETS = { ground: "Sol", air: "Air", both: "Sol + air", none: "Non armé" };
const DMG: Record<string, string> = {
  kinetic: "cinétique", cannon: "canon", flak: "DCA", missile: "missile", explosive: "explosif", laser: "arc électrique", precision: "précision"
};
const ARMOR: Record<string, string> = { light: "léger", medium: "moyen", heavy: "lourd", structure: "structure", infantry: "infanterie" };

type Threat = UnitKind | BuildingKind;
const isUnit = (k: string): k is UnitKind => k in UNITS;
/** The nation a card is read for: the kind's own, else the one given (Classique by default). */
const nationFor = (kind: UnitKind | BuildingKind, nation?: NationOrClassic): NationOrClassic =>
  (isUnit(kind) ? UNITS[kind].nation : BUILDINGS[kind].nation) ?? nation ?? "classique";
const threatName = (k: Threat, n: NationOrClassic): string => displayName(k, n);
/** The anchor of a kind's row: Classique's `kind`, a nation's `<nation>-<kind>` (models.html). */
export const rowId = (k: string, n: NationOrClassic = "classique"): string => (n === "classique" ? k : `${n}-${k}`);
/** A link to a foe's row: in a nation's card, the other nation's army. */
const threatLink = (k: Threat, n: NationOrClassic): string => {
  const foe = n === "classique" ? n : rival(n);
  return `<a href="#${rowId(k, foe)}">${threatName(k, foe)}</a>`;
};

/**
 * Who beats whom between the nations (PANACHE-CONCEPTION.md §1.5 « Toile des
 * contres », at equal cost), on top of the advisor's Classique table: what the
 * row kind beats. Read with COUNTERS for a nation's card, against the other
 * nation's roster only.
 */
export const NATION_COUNTERS: Partial<Record<Threat, Threat[]>> = {
  "jamais-contente": ["mastodon", "mortier-280", "harvester", "mortar"],
  stinger: ["jamais-contente", "fourgon", "branly"],
  fusiliers: ["jamais-contente", "gyroptere"],
  sapeurs: ["mastodon", "goliath", "mortier-280"],
  mastodon: ["sapeurs", "jamais-contente", "de-dion"],
  lancer: ["mastodon", "goliath", "stinger"],
  "mortier-280": ["arsonval", "sam-site", "branly"],
  wasp: ["mortier-280", "mastodon", "mortar", "atelier"],
  epervier: ["hornet", "zenith", "wasp", "condor", "mender"],
  raptor: ["epervier", "gyroptere", "vulcain", "titan"],
  "de-dion": ["gyroptere", "vulcain", "titan", "epervier"],
  "flak-crawler": ["wasp", "hornet", "zenith", "condor", "mender", "scout"],
  "flak-battery": ["wasp", "hornet", "zenith", "condor"],
  "rocket-squad": ["zenith", "lancer", "hornet"],
  carabiniers: ["trooper", "sapeurs", "sniper"],
  sniper: ["fusiliers", "carabiniers", "rocket-squad"],
  gyroptere: ["jamais-contente", "branly", "lancer", "fourgon"],
  vulcain: ["arsonval", "trooper", "sapeurs", "branly"],
  hornet: ["mastodon", "mortar", "fusiliers", "rocket-squad", "turret"],
  branly: ["turret", "fusiliers", "flak-battery", "mortar"],
  trooper: ["rocket-squad", "carabiniers"],
  arsonval: ["mastodon", "stinger", "fusiliers"],
  "sam-site": ["gyroptere", "vulcain", "titan"],
  turret: ["trooper", "sapeurs", "jamais-contente"],
  mortar: ["arsonval", "sam-site", "trooper", "sapeurs"],
  zenith: ["mastodon", "stinger", "mortar", "harvester"],
  goliath: ["jamais-contente", "trooper", "branly"]
};

/** What a kind beats on its card: the advisor's table in Classique, the nations' against the other nation's army. */
function beatsOf(kind: Threat, n: NationOrClassic): Threat[] {
  if (n === "classique") return (COUNTERS[kind] ?? []) as Threat[];
  const foe = rosterOf(rival(n));
  return (NATION_COUNTERS[kind] ?? []).filter((k) => foe.has(k));
}

// "Weak against" is the inverse of the counter table
function counteredBy(kind: Threat, n: NationOrClassic): Threat[] {
  if (n === "classique")
    return (Object.entries(COUNTERS) as [Threat, Threat[]][]).filter(([, beats]) => beats.includes(kind)).map(([k]) => k);
  const foe = rosterOf(rival(n));
  return (Object.entries(NATION_COUNTERS) as [Threat, Threat[]][]).filter(([k, beats]) => foe.has(k) && beats.includes(kind)).map(([k]) => k);
}

const rival = (n: Nation): Nation => (n === "republique" ? "empire" : "republique");

/** A nation's kind's matchups by name, against the other nation's army (the in-game info card). Empty lists: none known. */
export function nationMatchups(kind: Threat, n: Nation): { strong: string[]; weak: string[] } {
  const name = (k: Threat) => displayName(k, rival(n));
  return { strong: beatsOf(kind, n).map(name), weak: counteredBy(kind, n).map(name) };
}
/** Every unit and building a nation fields. */
export const rosterOf = (n: Nation): Set<Threat> => new Set<Threat>([...ROSTERS[n].units, ...ROSTERS[n].buildings]);

/** What every unit of a nation's army has, whatever its kind (the cards' last notes). */
function nationUnitNotes(kind: UnitKind, n: NationOrClassic): string[] {
  if (n === "classique") return [];
  const u = UNITS[kind];
  const out: string[] = [];
  if (n === "republique") {
    const t = NATIONS.republique.tsf;
    if (t && kind !== "zenith") out.push(`<b>Réseau TSF</b> : à ${t.radius} cases d'une Tour TSF ou d'un Zénith, vitesse ×${fmt(t.speed)} et vision +${t.sight}.`);
    out.push(`<b>Préfabriqué</b> : produit en ${fmt(u.buildTime * NATIONS.republique.unitTime)}${NB}s au lieu de ${u.buildTime}${NB}s.`);
  } else {
    const tr = NATIONS.empire.trench;
    if (u.squad && tr) out.push(`<b>Tranchées</b> : retranchée après ${tr.still}${NB}s immobile, dégâts subis ×${fmt(tr.mult)} (à ${fmt(tr.redoubtRadius)} cases d'une Hotchkiss : aussitôt).`);
    if (kind !== "goliath")
      out.push(`<b>Vapeur</b> : ${fmt(u.buildTime * NATIONS.empire.unitTime)}${NB}s de production au lieu de ${u.buildTime}${NB}s, mais chaque usine en fabrique ${NATIONS.empire.parallel} à la fois.`);
  }
  return out;
}

const stat = (value: string | number, label: string): string =>
  `<div class="stat"><b>${value}</b><span>${label}</span></div>`;


/** One of the Goliath's weapon systems: what it fires, how hard and how far, and when damage takes it offline. */
function goliathWeapon(w: GoliathWeaponStats): string {
  const bits = [
    `<b>${w.name}</b> ${DMG[w.dmgType!] ?? w.dmgType}`,
    `${fmt(shotDamage(w))} toutes les ${w.shotInterval ?? 0.5}${NB}s`,
    `portée ${w.range}${w.minRange ? ` (min ${w.minRange})` : ""}`,
    TARGETS[w.targets].toLowerCase(),
    w.lostBelow > 0 ? `hors service sous ${Math.round(w.lostBelow * 100)}${NB}% PV` : "jamais hors service"
  ];
  return bits.join(" · ");
}

function weaponLine(kind: UnitKind): string {
  const u = UNITS[kind];
  // four weapon systems, the long-ranged first (damage takes them in that order)
  if (kind === "goliath")
    return (["mortars", "laser", "cannons", "mg"] as const).map((k) => goliathWeapon(GOLIATH.weapons[k])).join("<br />");
  if (kind === "zenith")
    return (["branly", "arc", "bombs", "mg"] as const).map((k) => goliathWeapon(ZENITH.weapons[k])).join("<br />");
  if (u.heal) return `<b>${u.healTargets === "ground" ? "Atelier de réparation" : "Rayon de réparation"}</b> · ${u.heal} PV/s · portée ${u.range}${u.healTargets === "ground" ? " · sol et bâtiments seulement" : ""}`;
  return armedLine(u);
}

/** A unit's or building's weapon: its damage type, how hard and how often, and what it's strong against. */
function armedLine(u: ArmedStats): string {
  if (u.targets === "none") return "<b>Aucune arme</b>";
  const strong = (Object.entries(DAMAGE_VS[u.dmgType!]) as [ArmorClass, number][])
    .filter(([a, m]) => a !== "structure" ? m > 1 : m >= 1.3)
    .map(([a, m]) => `${a === "structure" ? "bâtiments" : a === "infantry" ? "infanterie" : `blindage ${ARMOR[a]}`} ×${fmt(m)}`);
  const bits = [
    `dégâts <b>${DMG[u.dmgType!] ?? u.dmgType}</b>`,
    `${fmt(shotDamage(u))} par tir toutes les ${u.shotInterval ?? 0.5}${NB}s`,
    u.minRange ? `portée min ${u.minRange}` : "",
    u.splash ? `zone ${u.splash} cases` : "",
    u.airMult ? `×${fmt(u.airMult)} contre l'air` : "",
    strong.length ? `fort contre ${strong.join(", ")}` : ""
  ];
  return bits.filter(Boolean).join(" · ");
}

/**
 * A unit's description card: name, role, tags, stats, weapon, notes and matchups.
 * `portrait: false` leaves out its portrait, and `id: false` the anchor (models.html
 * puts both on the row it shares with the unit's 3D model). `nation`: the army it is
 * read for (a nation's own kinds always read for theirs): its buildings' names, its
 * production times and notes, and matchups against the other nation.
 */
export function card(kind: UnitKind, { portrait = true, id = true, nation }: { portrait?: boolean; id?: boolean; nation?: NationOrClassic } = {}): string {
  const u = UNITS[kind];
  const n = nationFor(kind, nation);
  const beats = beatsOf(kind, n);
  const fears = counteredBy(kind, n);
  const time = n === "classique" ? u.buildTime : u.buildTime * NATIONS[n].unitTime;
  const tags = [
    n !== "classique" ? `<span class="tag nation ${n}">${NATIONS[n].short}</span>` : "",
    `<span class="tag">${u.hover ? "Hydroglisseur" : u.squad ? "Infanterie" : u.domain === "air" ? "Air" : "Sol"}</span>`,
    `<span class="tag">${u.armor === "infantry" ? `escouade de ${u.squad}` : `blindage ${ARMOR[u.armor]}`}</span>`,
    u.capacity ? `<span class="tag">Emporte ${u.capacity} escouades</span>` : "",
    `<span class="tag">${displayName(u.builtAt, n)}</span>`,
    u.requires ? `<span class="tag tech">⚗ Requiert ${displayName(u.requires, n)}</span>` : ""
  ].join("");
  const matchups =
    beats.length || fears.length
      ? `<div class="matchups">
          <div class="beats"><h4>Fort contre</h4>${beats.map((k) => threatLink(k, n)).join(", ") || "—"}</div>
          <div class="fears"><h4>Faible contre</h4>${fears.map((k) => threatLink(k, n)).join(", ") || "—"}</div>
        </div>`
      : "";
  const notes = [...FEATURES[kind], ...nationUnitNotes(kind, n)];
  return `<article${id ? ` id="${rowId(kind, n)}"` : ""}>
    <div class="head">
      ${portrait ? `<img src="./assets/icons/${portraitKind(kind)}.webp" alt="" loading="lazy" />` : ""}
      <div>
        <h3>${u.name}</h3>
        <div class="role">${u.role}</div>
        <div class="tags">${tags}</div>
      </div>
    </div>
    <div class="stats">
      ${stat(u.cost, "Charbon")}
      ${stat(u.hp, "PV")}
      ${stat(u.speed, "Vitesse")}
      ${stat(u.sight, "Vision")}
      ${stat(u.dps || (u.heal ? `+${u.heal}` : "—"), u.heal ? "Soin/s" : "DPS")}
      ${stat(u.range || "—", "Portée")}
      ${stat(TARGETS[u.targets], "Cibles")}
      ${stat(`${fmt(time)}${NB}s`, "Prod.")}
    </div>
    <div class="weapon">${weaponLine(kind)}</div>
    <ul class="features">${notes.map((f) => `<li>${f}</li>`).join("")}</ul>
    ${matchups}
  </article>`;
}

/** A nation's units (or Classique's) in groups by where they're built, as the models page lists them. */
export function unitGroups(n: NationOrClassic): { title: string; kinds: UnitKind[] }[] {
  if (n === "classique") return GROUPS;
  const units = ROSTERS[n].units;
  const by = (k: BuildingKind, what: string) => {
    const kinds = units.filter((u) => UNITS[u].builtAt === k);
    return kinds.length ? [{ title: `${displayName(k, n)} — ${what}`, kinds }] : [];
  };
  return [
    ...by("hq", "récolteur"),
    ...by("fab-plant", "véhicules terrestres"),
    ...by("assembly-bay", "infanterie automate"),
    ...by("airpad", "aéronefs"),
    ...by("gantry", "super-unité")
  ];
}

// ------------------------------------------------------------ buildings ---

/** The map's objectives: no one builds them, both sides fight over them. */
export type ObjectiveKind = "uplink" | "supply-crate";
export type SiteKind = BuildingKind | ObjectiveKind;

export const BUILDING_GROUPS: { title: string; kinds: SiteKind[] }[] = [
  { title: "Commandement et économie", kinds: ["hq", "depot", "radar"] },
  { title: "Production", kinds: ["fab-plant", "airpad", "assembly-bay", "tech-lab", "gantry"] },
  { title: "Défenses", kinds: ["turret", "sam-site"] },
  { title: "Objectifs de carte", kinds: ["uplink", "supply-crate"] }
];

const isObjective = (k: SiteKind): k is ObjectiveKind => k === "uplink" || k === "supply-crate";
const U = OBJECTIVES.uplink;
const D = OBJECTIVES.drops;
const mmss = (s: number): string => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
const OBJECTIVE_INFO: Record<ObjectiveKind, { name: string; role: string; tags: string[]; stats: [string | number, string][]; features: string[] }> = {
  uplink: {
    name: "Relais TSF",
    role: "Un relais capturable au cœur disputé de la carte : charbon, vision et charge de commandement pour qui le tient.",
    tags: ["Neutre", "Capturable"],
    stats: [[`${U.income}/s`, "Charbon"], [U.sight, "Vision"], [U.radius, "Zone"], [`~${Math.round(100 / U.maxRate)}${NB}s`, "Capture"]],
    features: [
      `Gare des unités dans sa zone de ${U.radius} cases pour faire pencher la barre de capture : de neutre à toi, il faut environ ${Math.round(100 / U.maxRate)} s avec quatre unités, deux fois plus pour le reprendre à l'ennemi.`,
      `Les escouades d'infanterie comptent ${INFANTRY.captureWeight}× et les appareils ${U.airWeight}× ; les Fardiers ne comptent pas.`,
      `Son détenteur gagne ${U.income} de charbon par seconde, voit à ${U.sight} cases autour et recharge sa jauge de commandement pour les frappes.`,
      "Certains sont sur des îles que seule l'infanterie amenée en Montgolfière peut prendre, et un relais insulaire ne rapporte que tant que des troupes l'occupent."
    ]
  },
  "supply-crate": {
    name: "Caisse de ravitaillement",
    role: "Parachutées par paires sur le champ de bataille : la première unité sur place la prend.",
    tags: ["Neutre", "Annoncée aux deux camps"],
    stats: [[mmss(D.first), "Première"], [`${D.every}${NB}s`, "Toutes les"], [`${D.warning}${NB}s`, "Préavis"], [`${D.ttl}${NB}s`, "Durée"]],
    features: [
      `Le premier largage arrive à ${mmss(D.first)}, puis un toutes les ${D.every} s, annoncé aux deux camps ${D.warning} s à l'avance par une colonne de lumière là où il tombera.`,
      `Toute unité sauf un Fardier qui s'approche à ${D.claimRadius} cases la récupère ; sinon, elle se consume après ${D.ttl} s.`,
      `Contenu : ${D.scrap} de charbon, Vétérans (+1 rang à l'unité et aux alliés à ${D.veteranRadius} cases), Réparation de campagne (${Math.round(D.repairShare * 100)} % de PV à tes unités à ${D.repairRadius} cases), +${D.charge} de charge de commandement, ou, rarement, un Hydroglisseur offert.`
    ]
  }
};

/** A building's or objective's name. */
export const siteName = (k: SiteKind, nation?: NationOrClassic): string => (isObjective(k) ? OBJECTIVE_INFO[k].name : displayName(k, nation));

/** A building's or objective's card (buildingCard(), or the objective's own). */
export function siteCard(kind: SiteKind, { id = true, nation }: { id?: boolean; nation?: NationOrClassic } = {}): string {
  if (!isObjective(kind)) return buildingCard(kind, { id, ...(nation ? { nation } : {}) });
  const o = OBJECTIVE_INFO[kind];
  return `<article${id ? ` id="${kind}"` : ""}>
    <div class="head">
      <div>
        <h3>${o.name}</h3>
        <div class="role">${o.role}</div>
        <div class="tags">${o.tags.map((t) => `<span class="tag">${t}</span>`).join("")}</div>
      </div>
    </div>
    <div class="stats">${o.stats.map(([v, l]) => stat(v, l)).join("")}</div>
    <ul class="features">${o.features.map((f) => `<li>${f}</li>`).join("")}</ul>
  </article>`;
}

const BUILDING_FEATURES: Record<BuildingKind, string[]> = {
  hq: [
    "Chaque camp en a un au départ, et on ne peut pas en construire : le cœur de ta base.",
    `Produit les Fardiers et reçoit leur charbon, et récupère seul ${ECONOMY.hqTrickle} de charbon par seconde : un camp ruiné n'est jamais bloqué.`,
    "Son canon de défense rapprochée chasse les premiers raids d'aéronefs. Il ne touche pas les unités au sol : laisse-les aux vraies défenses.",
    "Perds-le avec tous tes Gargantuas, et la partie est perdue."
  ],
  "fab-plant": [
    "Les forges des véhicules terrestres : chars, DCA, artillerie et hydroglisseurs sortent de leurs halls.",
    `Jusqu'à ${ECONOMY.maxQueue} en file d'attente ; touche la carte pour fixer le point de ralliement.`,
    "Les modèles lourds exigent aussi Polytechnique."
  ],
  airpad: [
    "Lance tous les aéronefs, de la Patrie à la Montgolfière de transport.",
    `Jusqu'à ${ECONOMY.maxQueue} en file d'attente ; touche la carte pour fixer le point de ralliement.`,
    "Les appareils ignorent le terrain : un Parc de Chalais-Meudon n'importe où peut frapper partout."
  ],
  "assembly-bay": [
    "Assemble l'infanterie automate : Escouades de pioupious, Escouades d'artificiers et Sections de chasseurs alpins.",
    "Les escouades sont bon marché, se mettent à couvert dans les bois et capturent les Relais plus vite que tout.",
    "Un Gargantua ancré forme aussi de l'infanterie, où qu'il soit."
  ],
  "tech-lab": [
    "Recherche, pas production : elle débloque les unités lourdes des autres bâtiments de production.",
    "Requiert d'abord des Forges, un Parc de Chalais-Meudon ou une Manufacture.",
    "Perds-la et ces unités sont indisponibles jusqu'à sa reconstruction."
  ],
  gantry: [
    `Construit le Gargantua, un à la fois en ${UNITS.goliath.buildTime} s : la machine s'élève par étapes sur son berceau, la grue posant les plaques de blindage.`,
    "Requiert tous les autres bâtiments de production et Polytechnique. Une par camp.",
    "L'ennemi la voit toujours, ainsi que le Gargantua qui y prend forme : attends-toi à ce qu'il vienne le chercher."
  ],
  depot: [
    "Un point de dépôt avancé : les Fardiers déchargent au plus proche, donc des Halles près d'un gisement éloigné raccourcissent leur trajet.",
    "Les Fardiers y déchargent comme au GQG ; elles ne produisent rien.",
    "Bâties près d'un Gargantua ancré, des Halles d'avant-poste reçoivent le charbon n'importe où sur la carte."
  ],
  turret: [
    "Mitrailleuse de défense qui touche sol et air.",
    `Les Canons de 75 portent plus loin (${UNITS.mortar.range} cases contre ${BUILDINGS.turret.range}) : perce-la à l'artillerie, pas aux chars.`,
    `Obus cinétiques : moins efficaces contre les blindés lourds (×${DAMAGE_VS.kinetic.heavy}), les Creusot s'en moquent.`
  ],
  "sam-site": [
    `Fusées antiaériennes longue portée, jusqu'à ${BUILDINGS["sam-site"].range} cases : plus loin que l'arme de n'importe quel appareil.`,
    "Ne peut rien viser au sol : chars et artillerie passent sous son nez.",
    "Associe-la à une Hotchkiss pour couvrir les deux."
  ],
  radar: [
    `Voit à ${BUILDINGS.radar.sight} cases dans toutes les directions, la plus large vision du jeu, grâce à la télégraphie sans fil.`,
    "Guette les attaques à travers le brouillard, ou repère le prochain gisement.",
    "Non armée et fragile : facile à perdre lors d'un raid."
  ],
  arsonval: [
    `La défense au sol de la République : un arc électrique qui perce les blindés (${DAMAGE_VS.laser.heavy}× contre les blindages lourds) — Creusot et Panhard y fondent.`,
    "Ne tire pas en l'air : associe-la à une Batterie Ruggieri. La République n'a pas de Hotchkiss.",
    `Portée ${BUILDINGS.arsonval.range} : le Mortier de 280 (${UNITS["mortier-280"].range}) et le Canon de 75 (${UNITS.mortar.range}) la démolissent de loin.`
  ],
  "flak-battery": [
    `Canons antiaériens à vapeur : barrage de DCA jusqu'à ${BUILDINGS["flak-battery"].range} cases contre tout aéronef, Zénith compris.`,
    "Ne vise rien au sol : la Hotchkiss couvre le terrain.",
    "Le Canon Branly la perce à distance ; sa robustesse impériale la rend longue à abattre."
  ]
};

/** How a nation's buildings differ from Classique's (§1.2, §1.6): their notes, replacing Classique's where named. */
const NATION_BUILDING_FEATURES: Record<Nation, Partial<Record<BuildingKind, string[]>>> = {
  republique: {
    "sam-site": [
      `Fusées antiaériennes longue portée, jusqu'à ${fmt(BUILDINGS["sam-site"].range)} cases : plus loin que l'arme de n'importe quel appareil.`,
      "Ne peut rien viser au sol : associe-la à une Bobine d'Arsonval pour couvrir les deux."
    ],
    "fab-plant": [
      "Le garage des véhicules électriques : Jamais-Contente, Autocanons De Dion, Canons Branly et Hydroglisseurs.",
      `Jusqu'à ${ECONOMY.maxQueue} en file d'attente ; touche la carte pour fixer le point de ralliement.`
    ],
    hq: [
      "Le cœur de ta base, et la première source du réseau électrique : il alimente les bâtiments dont l'emprise est à " +
        `${NATIONS.republique.power?.hqRadius ?? 0} cases de son centre.`,
      `Produit les Fourgons Jeantaud et reçoit leur charbon ; récupère seul ${ECONOMY.hqTrickle} de charbon par seconde.`,
      "Son canon de défense rapprochée chasse les premiers raids d'aéronefs. Perds-le avec tous tes Zéniths, et la partie est perdue."
    ],
    radar: [
      `Le pylône du réseau : alimente les bâtiments à ${NATIONS.republique.power?.towerRadius ?? 0} cases, et toute unité de la République à ${NATIONS.republique.tsf?.radius ?? 0} cases gagne vitesse ×${fmt(NATIONS.republique.tsf?.speed ?? 1)} et vision +${NATIONS.republique.tsf?.sight ?? 0}.`,
      `Ne coûte que ${Math.round((NATIONS.republique.towerCost ?? BUILDINGS.radar.cost) * NATIONS.republique.buildingCost)} et suit la règle classique des 6 cases : bâtis-en pour étendre ta base.`,
      "Fragile : chasser les Tours TSF, c'est éteindre la République. Protège-les."
    ],
    gantry: [
      `Construit le Zénith, un à la fois en ${fmt(UNITS.zenith.buildTime * NATIONS.republique.unitTime)} s.`,
      "Requiert tous les autres bâtiments de production et Polytechnique. Un par camp.",
      "L'ennemi le voit toujours, ainsi que le Zénith qui y prend forme."
    ],
    depot: [
      "Un point de dépôt avancé : les Fourgons déchargent au plus proche, donc une Station de charge près d'un gisement éloigné raccourcit leur trajet.",
      "Doit être alimentée comme tout bâtiment : bâtis d'abord une Tour TSF à côté des gisements éloignés."
    ]
  },
  empire: {
    airpad: [
      "Lance les aéronefs à vapeur : Gyroptères, Éperviers, Vulcains et Titans.",
      `Jusqu'à ${ECONOMY.maxQueue} en file d'attente ; touche la carte pour fixer le point de ralliement.`,
      "Les appareils ignorent le terrain : un Aérodrome n'importe où peut frapper partout."
    ],
    "assembly-bay": [
      "Assemble l'infanterie automate impériale : Fusiliers, Artificiers et Carabiniers.",
      "Les escouades impériales se retranchent : postées, elles tiennent le terrain mieux que tout."
    ],
    hq: [
      "Le cœur de ta base : produit les Fardiers et reçoit leur charbon, et récupère seul " + `${ECONOMY.hqTrickle} de charbon par seconde.`,
      "Sa DCA est celle du GQG : elle chasse les premiers raids d'aéronefs.",
      "Perds-la avec tous tes Gargantuas, et la partie est perdue."
    ],
    radar: [
      `Un observatoire captif : voit à ${BUILDINGS.radar.sight} cases à travers le brouillard, et rien d'autre.`,
      "Le guetteur idéal du Mortier de 280 : bâtis-le face à la base ennemie.",
      "Non armé et fragile."
    ],
    turret: [
      "Mitrailleuse de défense qui touche sol et air.",
      `Les escouades impériales à ${NATIONS.empire.trench?.redoubtRadius ?? 0} cases d'elle sont aussitôt retranchées (dégâts ×${fmt(NATIONS.empire.trench?.mult ?? 1)}).`,
      `Obus cinétiques : moins efficaces contre les blindés lourds (×${DAMAGE_VS.kinetic.heavy}).`
    ]
  }
};

/** A nation's notes on any of its buildings: Préfabriqué and the network, or Vapeur. */
function nationBuildingNotes(kind: BuildingKind, n: NationOrClassic): string[] {
  if (n === "classique") return [];
  const s = NATIONS[n];
  const out: string[] = [];
  if (n === "republique") {
    if (kind !== "hq" && kind !== "radar")
      out.push(`<b>Hors réseau : à l'arrêt.</b> Ne se pose qu'à ${s.power?.hqRadius ?? 0} cases du GQG ou ${s.power?.towerRadius ?? 0} d'une Tour TSF ; si sa source tombe, il cesse de produire et de tirer.`);
    out.push(`<b>Préfabriqué</b> : coût ×${fmt(s.buildingCost)}, construction ×${fmt(s.buildingTime)}, PV ×${fmt(s.buildingHp)}.`);
  } else {
    out.push(`<b>Vapeur</b> : coût ×${fmt(s.buildingCost)}, construction ×${fmt(s.buildingTime)}, PV ×${fmt(s.buildingHp)}.`);
    if (kind === "fab-plant" || kind === "airpad" || kind === "assembly-bay")
      out.push(`Fabrique ${s.parallel} unités de sa file à la fois, chacune ${fmt(s.unitTime)}× plus lentement.`);
  }
  return out;
}

/** A nation's buildings (or Classique's) in groups, as the models page lists them. */
export function buildingGroups(n: NationOrClassic): { title: string; kinds: SiteKind[] }[] {
  if (n === "classique") return BUILDING_GROUPS;
  const has = new Set(ROSTERS[n].buildings);
  const pick = (ks: BuildingKind[]) => ks.filter((k) => has.has(k));
  return [
    { title: "Commandement et économie", kinds: pick(["hq", "depot", "radar"]) },
    { title: "Production", kinds: pick(["fab-plant", "airpad", "assembly-bay", "tech-lab", "gantry"]) },
    { title: "Défenses", kinds: pick(["arsonval", "turret", "sam-site", "flak-battery"]) }
  ];
}

/**
 * A building's description card: name, role, tags, stats, weapon, notes and
 * what it builds or unlocks. `id: false` leaves out the anchor (as card()).
 * `nation`: the army it is read for (its name, numbers, roster and notes).
 */
export function buildingCard(kind: BuildingKind, { id = true, nation }: { id?: boolean; nation?: NationOrClassic } = {}): string {
  const b = BUILDINGS[kind];
  const n = nationFor(kind, nation);
  const s = n === "classique" ? null : NATIONS[n];
  const own = n === "classique" ? undefined : NATION_BUILDINGS[n][kind];
  const B = (k: BuildingKind): string => `<a href="#${rowId(k, n)}">${displayName(k, n)}</a>`;
  const Un = (k: UnitKind): string => `<a href="#${rowId(k, n)}">${UNITS[k].name}</a>`;
  const kinds = n === "classique" ? (Object.keys(UNITS) as UnitKind[]).filter((k) => !UNITS[k].nation) : ROSTERS[n].units;
  const builds = kinds.filter((k) => UNITS[k].builtAt === kind);
  const unlocks = kinds.filter((k) => UNITS[k].requires === kind);
  const cost = s ? Math.round((kind === "radar" && s.towerCost !== undefined ? s.towerCost : b.cost) * s.buildingCost) : b.cost;
  const hp = s ? Math.round(b.hp * s.buildingHp) : b.hp;
  const time = s ? b.buildTime * s.buildingTime : b.buildTime;
  const tags = [
    s ? `<span class="tag nation ${n}">${s.short}</span>` : "",
    `<span class="tag">${b.size}×${b.size}</span>`,
    b.dropOff ? `<span class="tag">Dépôt de charbon</span>` : "",
    b.unique ? `<span class="tag">Unique par camp</span>` : "",
    b.alwaysVisible ? `<span class="tag">Toujours visible</span>` : "",
    b.requires ? `<span class="tag tech">Requiert ${b.requires.map((k) => displayName(k, n)).join(" ou ")}</span>` : "",
    b.requiresAll ? `<span class="tag tech">Requiert ${b.requiresAll.map((k) => displayName(k, n)).join(", ")}</span>` : ""
  ].join("");
  const armed = b.targets !== "none";
  const beats = beatsOf(kind, n);
  const lists = [
    builds.length ? `<div class="beats"><h4>Produit</h4>${builds.map(Un).join(", ")}</div>` : "",
    unlocks.length ? `<div class="beats"><h4>Débloque</h4>${unlocks.map(Un).join(", ")}</div>` : "",
    n !== "classique" && beats.length ? `<div class="beats"><h4>Fort contre</h4>${beats.map((k) => threatLink(k, n)).join(", ")}</div>` : "",
    b.requires || b.requiresAll
      ? `<div class="fears"><h4>Requiert</h4>${b.requires ? b.requires.map(B).join(" ou ") : b.requiresAll!.map(B).join(", ")}</div>`
      : ""
  ].filter(Boolean);
  const notes = [...((n !== "classique" && NATION_BUILDING_FEATURES[n][kind]) || BUILDING_FEATURES[kind]), ...nationBuildingNotes(kind, n)];
  return `<article${id ? ` id="${rowId(kind, n)}"` : ""}>
    <div class="head">
      <div>
        <h3>${displayName(kind, n)}</h3>
        <div class="role">${own?.role ?? b.role}</div>
        <div class="tags">${tags}</div>
      </div>
    </div>
    <div class="stats">
      ${stat(cost || "—", "Charbon")}
      ${stat(hp, "PV")}
      ${stat(b.sight, "Vision")}
      ${stat(time ? `${fmt(time)}${NB}s` : "—", "Prod.")}
      ${armed ? stat(b.dps, "DPS") : ""}
      ${armed ? stat(b.range, "Portée") : ""}
      ${armed ? stat(TARGETS[b.targets], "Cibles") : ""}
    </div>
    ${armed ? `<div class="weapon">${armedLine(b)}</div>` : ""}
    <ul class="features">${notes.map((f) => `<li>${f}</li>`).join("")}</ul>
    ${lists.length ? `<div class="matchups">${lists.join("")}</div>` : ""}
  </article>`;
}
