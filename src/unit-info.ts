// Every unit's and building's description, read from balance.ts so it never
// drifts from the game, plus hand-written notes on what makes each one
// special: the cards on the vehicles page (vehicles.html) and the 3D models
// page (models.html).
import {
  BUILDINGS, DAMAGE_VS, ECONOMY, GOLIATH, INFANTRY, OBJECTIVES, TERRAIN, UNITS, shotDamage,
  type ArmedStats, type GoliathWeaponStats
} from "./sim/balance";
import { COUNTERS } from "./game/advisor";
import { Terrain, type ArmorClass, type BuildingKind, type UnitKind } from "./sim/types";

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
    "Intercepteur de supériorité aérienne : des missiles rapides qui chassent les autres appareils.",
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
  ]
};

export const GROUPS: { title: string; kinds: UnitKind[] }[] = [
  { title: "Produit au GQG", kinds: ["harvester"] },
  { title: "Forges — véhicules terrestres", kinds: ["stinger", "flak-crawler", "mortar", "mastodon", "lancer"] },
  { title: "Manufacture — infanterie automate", kinds: ["trooper", "rocket-squad", "sniper"] },
  { title: "Parc de Chalais-Meudon — aéronefs", kinds: ["scout", "wasp", "raptor", "hornet", "mender", "condor"] },
  { title: "Galerie des Machines — Gargantua", kinds: ["goliath"] }
];

const BUILT_AT = (k: BuildingKind): string => BUILDINGS[k].name;
const TARGETS = { ground: "Sol", air: "Air", both: "Sol + air", none: "Non armé" };
const DMG: Record<string, string> = {
  kinetic: "cinétique", cannon: "canon", flak: "DCA", missile: "missile", explosive: "explosif", laser: "arc électrique", precision: "précision"
};
const ARMOR: Record<string, string> = { light: "léger", medium: "moyen", heavy: "lourd", structure: "structure", infantry: "infanterie" };

type Threat = UnitKind | "turret" | "sam-site";
const threatName = (k: Threat): string =>
  k === "turret" || k === "sam-site" ? BUILDINGS[k].name : UNITS[k].name;
const threatLink = (k: Threat): string =>
  k in UNITS ? `<a href="#${k}">${threatName(k)}</a>` : threatName(k);

// "Weak against" is the inverse of the advisor's counter table
const counteredBy = (kind: UnitKind): Threat[] =>
  (Object.entries(COUNTERS) as [Threat, Threat[]][]).filter(([, beats]) => beats.includes(kind)).map(([k]) => k);

const stat = (value: string | number, label: string): string =>
  `<div class="stat"><b>${value}</b><span>${label}</span></div>`;

const fmt = (n: number): string => String(Math.round(n * 100) / 100).replace(".", ",");
const NB = "\u00a0";

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
  if (u.heal) return `<b>Rayon de réparation</b> · ${u.heal} PV/s · portée ${u.range}`;
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
 * puts both on the row it shares with the unit's 3D model).
 */
export function card(kind: UnitKind, { portrait = true, id = true } = {}): string {
  const u = UNITS[kind];
  const beats = (COUNTERS[kind] ?? []) as Threat[];
  const fears = counteredBy(kind);
  const tags = [
    `<span class="tag">${u.hover ? "Hydroglisseur" : u.squad ? "Infanterie" : u.domain === "air" ? "Air" : "Sol"}</span>`,
    `<span class="tag">${u.armor === "infantry" ? `escouade de ${u.squad}` : `blindage ${ARMOR[u.armor]}`}</span>`,
    u.capacity ? `<span class="tag">Emporte ${u.capacity} escouades</span>` : "",
    `<span class="tag">${BUILT_AT(u.builtAt)}</span>`,
    u.requires ? `<span class="tag tech">⚗ Requiert ${BUILDINGS[u.requires].name}</span>` : ""
  ].join("");
  const matchups =
    beats.length || fears.length
      ? `<div class="matchups">
          <div class="beats"><h4>Fort contre</h4>${beats.map(threatLink).join(", ") || "—"}</div>
          <div class="fears"><h4>Faible contre</h4>${fears.map(threatLink).join(", ") || "—"}</div>
        </div>`
      : "";
  return `<article${id ? ` id="${kind}"` : ""}>
    <div class="head">
      ${portrait ? `<img src="./assets/icons/${kind}.webp" alt="" loading="lazy" />` : ""}
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
      ${stat(`${u.buildTime}${NB}s`, "Prod.")}
    </div>
    <div class="weapon">${weaponLine(kind)}</div>
    <ul class="features">${FEATURES[kind].map((f) => `<li>${f}</li>`).join("")}</ul>
    ${matchups}
  </article>`;
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
export const siteName = (k: SiteKind): string => (isObjective(k) ? OBJECTIVE_INFO[k].name : BUILDINGS[k].name);

/** A building's or objective's card (buildingCard(), or the objective's own). */
export function siteCard(kind: SiteKind, { id = true } = {}): string {
  if (!isObjective(kind)) return buildingCard(kind, { id });
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
    `Missiles antiaériens longue portée, jusqu'à ${BUILDINGS["sam-site"].range} cases : plus loin que l'arme de n'importe quel appareil.`,
    "Ne peut rien viser au sol : chars et artillerie passent sous son nez.",
    "Associe-la à une Hotchkiss pour couvrir les deux."
  ],
  radar: [
    `Voit à ${BUILDINGS.radar.sight} cases dans toutes les directions, la plus large vision du jeu, grâce à la télégraphie sans fil.`,
    "Guette les attaques à travers le brouillard, ou repère le prochain gisement.",
    "Non armée et fragile : facile à perdre lors d'un raid."
  ]
};

const B_NAME = (k: BuildingKind): string => `<a href="#${k}">${BUILDINGS[k].name}</a>`;
const U_NAME = (k: UnitKind): string => `<a href="#${k}">${UNITS[k].name}</a>`;

/**
 * A building's description card: name, role, tags, stats, weapon, notes and
 * what it builds or unlocks. `id: false` leaves out the anchor (as card()).
 */
export function buildingCard(kind: BuildingKind, { id = true } = {}): string {
  const b = BUILDINGS[kind];
  const kinds = Object.keys(UNITS) as UnitKind[];
  const builds = kinds.filter((k) => UNITS[k].builtAt === kind);
  const unlocks = kinds.filter((k) => UNITS[k].requires === kind);
  const tags = [
    `<span class="tag">${b.size}×${b.size}</span>`,
    b.dropOff ? `<span class="tag">Dépôt de charbon</span>` : "",
    b.unique ? `<span class="tag">Unique par camp</span>` : "",
    b.alwaysVisible ? `<span class="tag">Toujours visible</span>` : "",
    b.requires ? `<span class="tag tech">Requiert ${b.requires.map((k) => BUILDINGS[k].name).join(" ou ")}</span>` : "",
    b.requiresAll ? `<span class="tag tech">Requiert ${b.requiresAll.map((k) => BUILDINGS[k].name).join(", ")}</span>` : ""
  ].join("");
  const armed = b.targets !== "none";
  const lists = [
    builds.length ? `<div class="beats"><h4>Produit</h4>${builds.map(U_NAME).join(", ")}</div>` : "",
    unlocks.length ? `<div class="beats"><h4>Débloque</h4>${unlocks.map(U_NAME).join(", ")}</div>` : "",
    b.requires || b.requiresAll
      ? `<div class="fears"><h4>Requiert</h4>${b.requires ? b.requires.map(B_NAME).join(" ou ") : b.requiresAll!.map(B_NAME).join(", ")}</div>`
      : ""
  ].filter(Boolean);
  return `<article${id ? ` id="${kind}"` : ""}>
    <div class="head">
      <div>
        <h3>${b.name}</h3>
        <div class="role">${b.role}</div>
        <div class="tags">${tags}</div>
      </div>
    </div>
    <div class="stats">
      ${stat(b.cost || "—", "Charbon")}
      ${stat(b.hp, "PV")}
      ${stat(b.sight, "Vision")}
      ${stat(b.buildTime ? `${b.buildTime}${NB}s` : "—", "Prod.")}
      ${armed ? stat(b.dps, "DPS") : ""}
      ${armed ? stat(b.range, "Portée") : ""}
      ${armed ? stat(TARGETS[b.targets], "Cibles") : ""}
    </div>
    ${armed ? `<div class="weapon">${armedLine(b)}</div>` : ""}
    <ul class="features">${BUILDING_FEATURES[kind].map((f) => `<li>${f}</li>`).join("")}</ul>
    ${lists.length ? `<div class="matchups">${lists.join("")}</div>` : ""}
  </article>`;
}
