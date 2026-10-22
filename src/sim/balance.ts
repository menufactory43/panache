import {
  Terrain,
  type ArmorClass,
  type BuildingKind,
  type DamageType,
  type Domain,
  type Nation,
  type NationOrClassic,
  type PowerKind,
  type Role,
  type TargetDomain,
  type UnitKind,
  type WeaponFx
} from "./types";

/**
 * Every tunable number in the game lives here.
 * Distances are in tiles, speeds in tiles/second, times in seconds,
 * damage in HP/second — the sim converts to per-tick internally.
 */
export const TICK_RATE = 10;
export const TICKS_PER_SEC = TICK_RATE;

/** Weapon/armor fields shared by units and armed buildings. */
export interface ArmedStats {
  targets: TargetDomain;
  /** Sustained damage per second against a 1.0× armor match. */
  dps: number;
  range: number;
  /** Seconds between shots (damage per shot = dps × shotInterval). */
  shotInterval?: number;
  /** Can't fire at targets closer than this (artillery). */
  minRange?: number;
  /** Splash radius in tiles (full damage at centre, half at the edge). */
  splash?: number;
  /** If set, shots are simulated projectiles at this speed (tiles/s). */
  projectileSpeed?: number;
  dmgType?: DamageType;
  fx?: WeaponFx;
  /** Damage multiplier against aircraft (generalist weapons are weaker vs air). */
  airMult?: number;
}

export interface UnitStats extends ArmedStats {
  name: string;
  /** One-line role summary for the build-bar tooltip. */
  role: string;
  cost: number;
  hp: number;
  speed: number;
  sight: number;
  domain: Domain;
  armor: ArmorClass;
  /** Hovers: crosses water, ignores rough ground (still a ground target). */
  hover?: boolean;
  /** Repair beam: HP/second restored to one damaged friendly in range. */
  heal?: number;
  buildTime: number;
  builtAt: BuildingKind;
  /** Extra building that must exist before this unit can be produced. */
  requires?: BuildingKind;
  /** Rendered with a separately rotating turret. */
  turret?: boolean;
  /** Collision/visual radius in tiles. */
  radius: number;
  /**
   * Robot infantry: the number of robots the squad is drawn as. A squad is
   * one sim unit with one HP pool; a robot falls each time HP crosses a 1/N
   * step and DPS scales with the robots still standing (infantry.ts).
   */
  squad?: number;
  /** Transport (Condor): infantry squads it can carry. */
  capacity?: number;
  /** Always visible to the enemy, through fog and on the minimap (the Goliath: it can't hide). */
  alwaysVisible?: boolean;
  /**
   * The nation that alone fields this unit (PANACHE-CONCEPTION.md §1.5):
   * banned in Classique and for the other nation. Absent on the 16 Classique
   * units (each nation's share of them is in ROSTERS).
   */
  nation?: Nation;
  /** The Classique unit whose behaviour this one reuses (harvester, mender, trooper, sniper, condor, goliath). */
  base?: UnitKind;
  /** Harvesters: scrap a load holds (default ECONOMY.harvesterCapacity). */
  cargo?: number;
  /** Repairers: only ground units and buildings (the Atelier roulant), not aircraft. */
  healTargets?: "ground";
}

export interface BuildingStats extends ArmedStats {
  name: string;
  role: string;
  cost: number;
  hp: number;
  sight: number;
  /** Square footprint edge, in tiles. */
  size: number;
  buildTime: number;
  /** Any one of these must already stand before construction can start. */
  requires?: BuildingKind[];
  /** Every one of these must already stand before construction can start (the Gantry). */
  requiresAll?: BuildingKind[];
  /** One per side: it can't be started while the side has one (standing). */
  unique?: boolean;
  /** Always visible to the enemy, through fog and on the minimap, with what it is building. */
  alwaysVisible?: boolean;
  /** Harvesters may unload scrap here. */
  dropOff?: boolean;
  /** The nation that alone builds this defence (§1.6): banned in Classique and for the other nation. */
  nation?: Nation;
  /** The Classique building whose behaviour this one reuses (turret, sam-site). */
  base?: BuildingKind;
}

/**
 * Combat units carry 1.5× their original HP (Hornets 1.3×, so Flak still
 * answers them; Harvesters and Scouts unchanged): half an army now takes
 * ~7–9 s to die instead of 5–7, long enough to react on a phone.
 */
export const UNITS: Record<UnitKind, UnitStats> = {
  harvester: {
    name: "Fardier", role: "Extrait charbon et radium. Protège-le.",
    cost: 150, hp: 250, speed: 1.6, sight: 4, domain: "ground", armor: "medium",
    targets: "none", dps: 0, range: 0,
    buildTime: 10, builtAt: "hq", radius: 0.45
  },
  scout: {
    name: "Patrie", role: "Dirigeable de reconnaissance rapide. Non armée.",
    cost: 75, hp: 60, speed: 4.8, sight: 9, domain: "air", armor: "light",
    targets: "none", dps: 0, range: 0,
    buildTime: 4, builtAt: "airpad", radius: 0.3
  },
  stinger: {
    name: "Panhard", role: "Automitrailleuse rapide. Bat la DCA et les Canons de 75. Ne tire pas en l'air.",
    cost: 150, hp: 255, speed: 2.3, sight: 5, domain: "ground", armor: "medium",
    targets: "ground", dps: 22, range: 3.2, shotInterval: 0.6, dmgType: "kinetic", fx: "cannon",
    buildTime: 7, builtAt: "fab-plant", turret: true, radius: 0.38
  },
  "flak-crawler": {
    name: "Faucheux", role: "Antiaérien. Déchiquette les aéronefs. Impuissant au sol.",
    cost: 190, hp: 285, speed: 1.9, sight: 6, domain: "ground", armor: "medium",
    targets: "air", dps: 31, range: 5, shotInterval: 0.3, dmgType: "flak", fx: "flak",
    buildTime: 8, builtAt: "fab-plant", turret: true, radius: 0.4
  },
  mortar: {
    name: "Canon de 75", role: "Artillerie à zone longue portée. Rase les bases. Fragile de près.",
    cost: 275, hp: 195, speed: 1.5, sight: 6, domain: "ground", armor: "light",
    targets: "ground", dps: 18, range: 8, minRange: 2.5, shotInterval: 3,
    splash: 1.1, projectileSpeed: 5.5, dmgType: "explosive", fx: "shell",
    buildTime: 10, builtAt: "fab-plant", requires: "tech-lab", turret: true, radius: 0.42
  },
  mastodon: {
    name: "Creusot", role: "Char super-lourd. Écrase les armées légères. Ne tire pas en l'air.",
    cost: 475, hp: 1050, speed: 1.2, sight: 6, domain: "ground", armor: "heavy",
    targets: "ground", dps: 46, range: 4, shotInterval: 1.2, dmgType: "cannon", fx: "heavy-cannon",
    buildTime: 15, builtAt: "fab-plant", requires: "tech-lab", turret: true, radius: 0.55
  },
  lancer: {
    name: "Hydroglisseur", role: "Glisseur à arc électrique. Perce le blindage, touche l'air. Traverse l'eau.",
    cost: 275, hp: 405, speed: 2.5, sight: 6, domain: "ground", armor: "medium",
    hover: true,
    targets: "both", dps: 28, range: 4.5, shotInterval: 0.8, dmgType: "laser", fx: "laser", airMult: 0.65,
    buildTime: 11, builtAt: "fab-plant", requires: "tech-lab", turret: true, radius: 0.42
  },
  wasp: {
    name: "Éole", role: "Aéronef d'attaque. Roquettes sur cibles au sol. Craint la DCA.",
    cost: 200, hp: 205, speed: 3.6, sight: 6, domain: "air", armor: "light",
    targets: "ground", dps: 28, range: 3, shotInterval: 1, dmgType: "missile", fx: "rockets",
    buildTime: 8, builtAt: "airpad", radius: 0.35
  },
  raptor: {
    name: "Blériot", role: "Intercepteur. Chasse les unités aériennes. Ne tire pas au sol.",
    cost: 250, hp: 265, speed: 4.1, sight: 7, domain: "air", armor: "medium",
    targets: "air", dps: 32, range: 4, shotInterval: 0.8, dmgType: "missile", fx: "missile",
    buildTime: 9, builtAt: "airpad", radius: 0.38
  },
  hornet: {
    name: "Albatros", role: "Bombardier lourd. Tapis de bombes sur sol et bases. Escorte requise.",
    cost: 375, hp: 505, speed: 2.1, sight: 6, domain: "air", armor: "heavy",
    targets: "ground", dps: 36, range: 1.6, shotInterval: 2, splash: 1.1,
    projectileSpeed: 5, dmgType: "explosive", fx: "bomb",
    buildTime: 14, builtAt: "airpad", requires: "tech-lab", radius: 0.5
  },
  mender: {
    name: "Pasteur", role: "Aéronef de réparation. Soigne unités et bâtiments proches.",
    cost: 150, hp: 180, speed: 3.2, sight: 6, domain: "air", armor: "light",
    targets: "none", dps: 0, range: 3, heal: 10,
    buildTime: 7, builtAt: "airpad", radius: 0.32
  },
  // ---- robot infantry (INFANTRY.md): one sim unit each, drawn as `squad` robots ----
  // (tuned down from the spec's 225 HP / 18 DPS: cost for cost those beat Stingers by
  // 0.48 in tools/balance.ts duels; Stingers are meant to handle infantry)
  trooper: {
    name: "Escouade de pioupious", role: "Automates fusiliers bon marché. Tirent sol et air. À couvert dans les bois.",
    cost: 100, hp: 190, speed: 1.8, sight: 5, domain: "ground", armor: "infantry",
    targets: "both", dps: 15, range: 3, shotInterval: 0.4, dmgType: "kinetic", fx: "rifle", airMult: 0.5,
    buildTime: 6, builtAt: "assembly-bay", radius: 0.4, squad: 5
  },
  // (the spec's 180 HP and 0.8× vs air lost to Hornets by 0.59 cost for cost — their bombs
  // splash whole clumps of squads; 210 HP and 1.5× vs air kill them, as the role says)
  "rocket-squad": {
    name: "Escouade d'artificiers", role: "Roquettes antichar. Tuent Creusot et Albatros. Faibles contre l'infanterie.",
    cost: 175, hp: 210, speed: 1.6, sight: 6, domain: "ground", armor: "infantry",
    targets: "both", dps: 26, range: 4, shotInterval: 1.5, dmgType: "cannon", fx: "rockets", airMult: 1.5,
    buildTime: 9, builtAt: "assembly-bay", radius: 0.4, squad: 3
  },
  sniper: {
    name: "Section de chasseurs alpins", role: "Tireurs d'élite longue portée. Effacent l'infanterie. Inutiles contre les véhicules.",
    cost: 200, hp: 120, speed: 1.7, sight: 8, domain: "ground", armor: "infantry",
    // 50 per shot; precision ×3 vs infantry = 150 (about three Trooper robots)
    targets: "ground", dps: 20, range: 7, shotInterval: 2.5, dmgType: "precision", fx: "snipe",
    buildTime: 10, builtAt: "assembly-bay", requires: "tech-lab", radius: 0.35, squad: 2
  },
  condor: {
    name: "Montgolfière", role: "Transport. Emporte deux escouades par-dessus tout. Non armée.",
    cost: 200, hp: 400, speed: 3.6, sight: 6, domain: "air", armor: "medium",
    targets: "none", dps: 0, range: 0,
    buildTime: 9, builtAt: "airpad", radius: 0.5, capacity: 2
  },
  // The Goliath fights with GOLIATH.weapons (goliath.ts), not these: they
  // summarise them for estimates and tooltips (every weapon's DPS together,
  // the mortars' reach). Cost is the first one's: each costs GOLIATH.costStep more.
  goliath: {
    name: "Gargantua", role: "Machine géante qui marche, et base mobile. Ancre-la pour construire, produire et débarquer partout.",
    cost: 1600, hp: 3000, speed: 1.0, sight: 10, domain: "ground", armor: "heavy",
    targets: "both", dps: 125, range: 8,
    buildTime: 60, builtAt: "gantry", radius: 1.0, alwaysVisible: true
  },
  // ---- the nations' own units (PANACHE-CONCEPTION.md §1.5). Appended after the
  // 16 Classique units: code that indexes UNITS in key order keeps its Classique
  // indices. Build times are before the nation's unitTime multiplier. ----
  // République
  fourgon: {
    name: "Fourgon Jeantaud", role: "Fourgon électrique : extrait charbon et radium, vite et par petites charges.",
    nation: "republique", base: "harvester", cargo: 80,
    cost: 125, hp: 200, speed: 2.1, sight: 4, domain: "ground", armor: "medium",
    targets: "none", dps: 0, range: 0,
    buildTime: 8, builtAt: "hq", radius: 0.42
  },
  "jamais-contente": {
    name: "Jamais-Contente", role: "Bolide électrique. Arc court qui perce le blindage. Ne tire pas en l'air.",
    nation: "republique",
    cost: 140, hp: 210, speed: 3.0, sight: 6, domain: "ground", armor: "light",
    targets: "ground", dps: 21, range: 3.2, shotInterval: 0.7, dmgType: "laser", fx: "laser",
    buildTime: 6, builtAt: "fab-plant", turret: true, radius: 0.36
  },
  "de-dion": {
    name: "Autocanon De Dion", role: "Antiaérien rapide à tir de barrage. Impuissant au sol.",
    nation: "republique",
    // (230 HP lost to cost-equal Vulcains, −0.26 in tools/balance.ts duels --nations: anti-air beaten by the bomber it answers)
    cost: 175, hp: 260, speed: 2.4, sight: 7, domain: "ground", armor: "light",
    targets: "air", dps: 29, range: 5.5, shotInterval: 0.25, dmgType: "flak", fx: "flak",
    buildTime: 7, builtAt: "fab-plant", turret: true, radius: 0.38
  },
  branly: {
    name: "Canon Branly", role: "Canon électromagnétique : obus rapides, longue portée. Fragile de près.",
    nation: "republique",
    // (170 HP: 0.44 units killed per value lost in AI-vs-AI panels, the République's worst gun)
    cost: 260, hp: 200, speed: 1.8, sight: 6, domain: "ground", armor: "light",
    targets: "ground", dps: 17, range: 8.5, minRange: 2.5, shotInterval: 2.5,
    splash: 0.8, projectileSpeed: 9, dmgType: "explosive", fx: "arc-shell",
    buildTime: 9, builtAt: "fab-plant", requires: "tech-lab", turret: true, radius: 0.4
  },
  sapeurs: {
    name: "Escouade de sapeurs-électriciens", role: "Lances à arc antichar. Fondent Creusot et Gargantua. Ne tirent pas en l'air.",
    nation: "republique",
    cost: 175, hp: 200, speed: 1.7, sight: 6, domain: "ground", armor: "infantry",
    targets: "ground", dps: 24, range: 3.5, shotInterval: 1.2, dmgType: "laser", fx: "laser",
    buildTime: 9, builtAt: "assembly-bay", radius: 0.4, squad: 3
  },
  // Fights with ZENITH.weapons (WP2), like the Goliath with GOLIATH.weapons: these summarise them.
  zenith: {
    name: "Zénith", role: "Croiseur aérien et base volante. Amarre-le pour produire, réparer et récolter partout.",
    nation: "republique", base: "goliath",
    cost: 1500, hp: 2600, speed: 1.3, sight: 11, domain: "air", armor: "heavy",
    targets: "both", dps: 105, range: 7,
    buildTime: 55, builtAt: "gantry", radius: 1.1, alwaysVisible: true
  },
  // Empire de Carbonie
  estafette: {
    name: "Estafette", role: "Motocyclette à vapeur de reconnaissance. Rapide, non armée, reste au sol.",
    nation: "empire",
    cost: 60, hp: 90, speed: 4.2, sight: 8, domain: "ground", armor: "light",
    targets: "none", dps: 0, range: 0,
    buildTime: 4, builtAt: "fab-plant", radius: 0.3
  },
  "mortier-280": {
    name: "Mortier de 280", role: "Pièce de siège. Surclasse toute défense en portée. Aveugle : il lui faut un guetteur.",
    nation: "empire",
    cost: 425, hp: 280, speed: 0.9, sight: 6, domain: "ground", armor: "medium",
    targets: "ground", dps: 20, range: 11, minRange: 4, shotInterval: 6,
    splash: 1.5, projectileSpeed: 4.5, dmgType: "explosive", fx: "heavy-shell",
    buildTime: 14, builtAt: "fab-plant", requires: "tech-lab", turret: true, radius: 0.5
  },
  gyroptere: {
    name: "Gyroptère", role: "Autogire à vapeur d'attaque. Canon antichar sur cibles au sol. Craint la DCA.",
    nation: "empire",
    cost: 225, hp: 260, speed: 3.0, sight: 6, domain: "air", armor: "medium",
    targets: "ground", dps: 26, range: 3.2, shotInterval: 0.5, dmgType: "cannon", fx: "cannon",
    buildTime: 8, builtAt: "airpad", radius: 0.4
  },
  epervier: {
    name: "Épervier", role: "Chasseur à vapeur. Ses canons percent les grands aéronefs. Ne tire pas au sol.",
    nation: "empire",
    cost: 225, hp: 240, speed: 3.8, sight: 7, domain: "air", armor: "medium",
    targets: "air", dps: 30, range: 3.5, shotInterval: 0.5, dmgType: "cannon", fx: "mg",
    buildTime: 7, builtAt: "airpad", radius: 0.38
  },
  vulcain: {
    name: "Vulcain", role: "Bombardier blindé, lent. Écrase bases et colonnes. Escorte requise.",
    nation: "empire",
    cost: 425, hp: 650, speed: 1.6, sight: 6, domain: "air", armor: "heavy",
    targets: "ground", dps: 40, range: 1.6, shotInterval: 2.5, splash: 1.3,
    projectileSpeed: 4.5, dmgType: "explosive", fx: "bomb",
    buildTime: 13, builtAt: "airpad", requires: "tech-lab", radius: 0.6
  },
  atelier: {
    name: "Atelier roulant", role: "Locomobile de réparation. Répare véhicules, Gargantua et bâtiments. Pas les aéronefs.",
    nation: "empire", base: "mender", healTargets: "ground",
    cost: 160, hp: 320, speed: 1.7, sight: 5, domain: "ground", armor: "medium",
    targets: "none", dps: 0, range: 2.5, heal: 12,
    buildTime: 7, builtAt: "fab-plant", radius: 0.45
  },
  fusiliers: {
    name: "Escouade de fusiliers", role: "Automates fusiliers cuirassés. Tirent sol et air. Se retranchent.",
    nation: "empire", base: "trooper",
    cost: 125, hp: 260, speed: 1.5, sight: 5, domain: "ground", armor: "infantry",
    targets: "both", dps: 16, range: 3, shotInterval: 0.5, dmgType: "kinetic", fx: "rifle", airMult: 0.5,
    buildTime: 6, builtAt: "assembly-bay", radius: 0.4, squad: 5
  },
  carabiniers: {
    name: "Section de carabiniers", role: "Tireurs d'élite blindés. Effacent l'infanterie. Portée plus courte que les chasseurs alpins.",
    nation: "empire", base: "sniper",
    cost: 200, hp: 150, speed: 1.4, sight: 7, domain: "ground", armor: "infantry",
    targets: "ground", dps: 18, range: 6.5, shotInterval: 2.5, dmgType: "precision", fx: "snipe",
    buildTime: 8, builtAt: "assembly-bay", requires: "tech-lab", radius: 0.35, squad: 2
  },
  titan: {
    name: "Titan", role: "Dirigeable-cargo cuirassé. Emporte trois escouades ; deux Titans soulèvent un Gargantua.",
    nation: "empire", base: "condor",
    cost: 225, hp: 520, speed: 2.8, sight: 6, domain: "air", armor: "heavy",
    targets: "none", dps: 0, range: 0,
    buildTime: 9, builtAt: "airpad", radius: 0.6, capacity: 3
  }
};

export const BUILDINGS: Record<BuildingKind, BuildingStats> = {
  hq: {
    name: "GQG", role: "Grand Quartier Général. Produit des Fardiers, reçoit le charbon. Perds-le avec tous tes Gargantuas, et c'est la défaite.",
    cost: 0, hp: 3200, sight: 7, size: 3, buildTime: 0, dropOff: true,
    // point defence: swats early drone raids, leaves ground assaults to real defences
    targets: "air", dps: 9, range: 4.5, shotInterval: 0.5, dmgType: "kinetic", fx: "mg"
  },
  "fab-plant": {
    name: "Forges", role: "Produisent les véhicules terrestres.",
    cost: 300, hp: 1000, sight: 4, size: 2, buildTime: 10,
    targets: "none", dps: 0, range: 0
  },
  airpad: {
    name: "Parc de Chalais-Meudon", role: "Produit les aéronefs.",
    cost: 350, hp: 850, sight: 4, size: 2, buildTime: 12,
    targets: "none", dps: 0, range: 0
  },
  "tech-lab": {
    name: "Polytechnique", role: "Débloque Canon de 75, Creusot, Hydroglisseur, Albatros et Chasseurs alpins.",
    cost: 450, hp: 800, sight: 4, size: 2, buildTime: 20, requires: ["fab-plant", "airpad", "assembly-bay"],
    targets: "none", dps: 0, range: 0
  },
  depot: {
    name: "Halles", role: "Point de dépôt avancé. À bâtir près des gisements éloignés.",
    cost: 250, hp: 800, sight: 4, size: 2, buildTime: 10, dropOff: true,
    targets: "none", dps: 0, range: 0
  },
  turret: {
    name: "Hotchkiss", role: "Mitrailleuse de défense. Tire sol et air.",
    cost: 225, hp: 650, sight: 6, size: 1, buildTime: 8,
    targets: "both", dps: 26, range: 4.5, shotInterval: 0.5, dmgType: "kinetic", fx: "cannon"
  },
  "sam-site": {
    name: "Batterie Ruggieri", role: "Missiles antiaériens longue portée.",
    cost: 275, hp: 560, sight: 7, size: 1, buildTime: 9,
    targets: "air", dps: 32, range: 6.5, shotInterval: 1.2, dmgType: "missile", fx: "missile"
  },
  radar: {
    name: "Tour TSF", role: "Révèle une vaste zone à travers le brouillard.",
    cost: 200, hp: 450, sight: 13, size: 1, buildTime: 8,
    targets: "none", dps: 0, range: 0
  },
  "assembly-bay": {
    name: "Manufacture", role: "Produit l'infanterie automate.",
    cost: 250, hp: 700, sight: 4, size: 2, buildTime: 15,
    targets: "none", dps: 0, range: 0
  },
  gantry: {
    name: "Galerie des Machines", role: "Construit le Gargantua. Une par camp, toujours visible par l'ennemi.",
    cost: 600, hp: 1200, sight: 5, size: 3, buildTime: 25,
    requiresAll: ["fab-plant", "airpad", "tech-lab", "assembly-bay"], unique: true, alwaysVisible: true,
    targets: "none", dps: 0, range: 0
  },
  // ---- the two defences only one nation builds (§1.6) ----
  arsonval: {
    name: "Bobine d'Arsonval", role: "Tour à arc électrique. Perce les blindés au sol. Doit être alimentée.",
    nation: "republique", base: "turret",
    cost: 250, hp: 600, sight: 6, size: 1, buildTime: 8,
    targets: "ground", dps: 34, range: 4, shotInterval: 1, dmgType: "laser", fx: "laser"
  },
  "flak-battery": {
    name: "Batterie de 47", role: "Canons antiaériens à vapeur. Longue portée contre les aéronefs.",
    nation: "empire", base: "sam-site",
    cost: 275, hp: 700, sight: 7, size: 1, buildTime: 9,
    targets: "air", dps: 30, range: 6, shotInterval: 0.6, dmgType: "flak", fx: "flak"
  }
};

/** Damage multiplier by damage type (row) vs armor class (column). */
export const DAMAGE_VS: Record<DamageType, Record<ArmorClass, number>> = {
  kinetic: { light: 1.0, medium: 1.0, heavy: 0.6, structure: 0.65, infantry: 1.0 },
  cannon: { light: 0.8, medium: 1.0, heavy: 1.3, structure: 1.0, infantry: 0.4 },
  flak: { light: 1.25, medium: 1.0, heavy: 1.15, structure: 0.5, infantry: 1.25 },
  missile: { light: 1.15, medium: 1.0, heavy: 0.9, structure: 0.6, infantry: 0.7 },
  explosive: { light: 1.2, medium: 0.9, heavy: 0.85, structure: 1.35, infantry: 1.3 },
  laser: { light: 1.0, medium: 1.0, heavy: 1.55, structure: 0.8, infantry: 0.7 },
  // Sniper rail-rifles: deadly to robot infantry, next to useless against armour
  precision: { light: 0.6, medium: 0.4, heavy: 0.25, structure: 0.15, infantry: 3.0 }
};

export interface TerrainInfo {
  name: string;
  /** Tracked/wheeled units can enter. */
  ground: boolean;
  /** Hover units can enter. */
  hover: boolean;
  /** Speed multiplier for tracked/wheeled and hover units. */
  speed: number;
  hoverSpeed: number;
  /** Speed multiplier for robot infantry (0 = they can't enter: Water and Rock). */
  footSpeed: number;
  /** Buildings may be placed here. */
  buildable: boolean;
  /** Damage multiplier for ground units standing here (cover). */
  cover: number;
}

export const TERRAIN: Record<Terrain, TerrainInfo> = {
  [Terrain.Ground]: { name: "Sol", ground: true, hover: true, speed: 1, hoverSpeed: 1, footSpeed: 1, buildable: true, cover: 1 },
  [Terrain.Rock]: { name: "Rocher", ground: false, hover: false, speed: 0, hoverSpeed: 0, footSpeed: 0, buildable: false, cover: 1 },
  [Terrain.Scrap]: { name: "Gisement de charbon", ground: true, hover: true, speed: 0.85, hoverSpeed: 1, footSpeed: 0.85, buildable: false, cover: 1 },
  [Terrain.Water]: { name: "Eau", ground: false, hover: true, speed: 0, hoverSpeed: 1, footSpeed: 0, buildable: false, cover: 1 },
  [Terrain.Road]: { name: "Route", ground: true, hover: true, speed: 1.35, hoverSpeed: 1.15, footSpeed: 1.35, buildable: true, cover: 1 },
  [Terrain.Rough]: { name: "Terrain accidenté", ground: true, hover: true, speed: 0.6, hoverSpeed: 1, footSpeed: 1, buildable: false, cover: 1 },
  [Terrain.Forest]: { name: "Bois", ground: true, hover: true, speed: 0.55, hoverSpeed: 0.6, footSpeed: 1, buildable: false, cover: 0.7 },
  [Terrain.Crystal]: { name: "Gisement de radium", ground: true, hover: true, speed: 0.85, hoverSpeed: 1, footSpeed: 0.85, buildable: false, cover: 1 },
  [Terrain.Bridge]: { name: "Pont", ground: true, hover: true, speed: 1.35, hoverSpeed: 1.15, footSpeed: 1.35, buildable: false, cover: 1 },
  [Terrain.Shallows]: { name: "Hauts-fonds", ground: true, hover: true, speed: 0.5, hoverSpeed: 1, footSpeed: 0.8, buildable: false, cover: 1 },
  [Terrain.Deep]: { name: "Haute mer", ground: false, hover: false, speed: 0, hoverSpeed: 0, footSpeed: 0, buildable: false, cover: 1 }
};

/**
 * The island map's free replacement Condor (lifeline.ts): a side with no
 * Condor (none flying, none being built) gets one `delay` s later, flown in
 * from the map edge nearest its HQ. It brings a free Trooper Squad only while
 * the side has fewer than `squadUnder` squads, so it rescues a side that has
 * lost its infantry and can't be farmed for troops.
 */
export const LIFELINE = {
  delay: 45,
  squadUnder: 2,
  /** How far inside the map edge it appears (tiles). */
  edgeInset: 1.5
};

export const ECONOMY = {
  startingScrap: 600,
  /** Scrap a harvester can carry per trip. */
  harvesterCapacity: 100,
  /** Scrap mined per second while sitting on a field. */
  harvestRate: 21,
  /** Scrap transferred per second while unloading at a drop-off. */
  unloadRate: 140,
  /** Scrap in a fresh scrap-field tile. */
  scrapPerTile: 1500,
  /** Raw crystal in a fresh crystal tile… */
  crystalPerTile: 1200,
  /** …and each unit of it mined is worth this much scrap in the hold. */
  crystalValue: 1.6,
  /** New buildings must be placed within this range of a friendly building. */
  buildRadius: 6,
  /** Fraction of cost refunded when selling a building. */
  sellRefund: 0.5,
  /** Scrap per second every HQ salvages on its own (keeps broke sides alive). */
  hqTrickle: 2,
  /** Max units queued per production building. */
  maxQueue: 6
};

export const COMBAT = {
  /** Default seconds between shots; damage per shot = dps * this. */
  shotInterval: 0.5,
  /** Auto-acquire radius = weapon range + this bonus. */
  acquireBonus: 1.5,
  /** Idle units retaliate against attackers up to this far away. */
  retaliateRange: 9,
  /** Idle allies this close to a victim join in its defence. */
  assistRadius: 5,
  /**
   * Auto-targeting reckons an enemy Mender this many tiles closer than it is,
   * and a unit that can hit one drops its current auto-target for a Mender
   * in weapon range: kill the healer first, or the fight never ends.
   */
  healerPriority: 2.5,
  /** XP (fraction of own cost in kills) needed for ranks 1, 2, 3. */
  rankXp: [1, 2.5, 5],
  /** Damage bonus per veterancy rank. */
  rankDamage: 0.15,
  /** HP/sec regenerated at rank 3 (fraction of max HP). */
  eliteRegen: 0.01
};

/**
 * Robot infantry and the Condor dropship (INFANTRY.md; infantry.ts,
 * transport.ts). Squads are single sim units drawn as several robots.
 */
export const INFANTRY = {
  /** Damage multiplier for a squad standing in Woods (vehicles get TERRAIN cover 0.7). */
  woodsCover: 0.5,
  /** A Sniper Team in Woods is only seen by enemies this close (tiles)… */
  concealRadius: 3,
  /** …until this many seconds after it fires. */
  concealAfterShot: 2,
  /** HP/s a moving Mastodon deals to an enemy squad it rolls over. */
  crushDps: 30,
  /** A Mastodon crushes squads whose centre is within its radius + this (tiles). */
  crushReach: 0.15,
  /** Uplink capture weight of a squad (vehicles count 1, aircraft 0.5). */
  captureWeight: 2,
  /** Seconds a squad takes to climb aboard once it is within `boardRange` of the Condor. */
  boardTime: 1,
  /** Horizontal distance (tiles) between squad and Condor that counts as adjacent. */
  boardRange: 1.2,
  /** Seconds a Condor hovers over the drop point before the squads are down. */
  unloadHover: 1.5,
  /** How far (tiles) a drop may snap to find a tile infantry can stand on (past that: the nearest anywhere). */
  dropSearch: 6,
  /** Squads set down (dropped or bailed out) keep their centre this far (tiles) from ground they can't stand on and the map's edge: their robots stand around it. */
  dropClear: 0.4,
  /** After a drop the Condor backs off this far (tiles) the way it came, off its squads' heads. */
  dropBackOff: 1.5,
  /** A Condor shot down over walkable ground: passengers bail out with at most this share of their max HP. */
  bailoutHp: 0.5
};

export const FOG = {
  /** Visibility recompute cadence, in ticks (10Hz / 4 ≈ 2.5Hz–4Hz zone). */
  intervalTicks: 3
};

/** Damage per shot for a weapon, before armor/veterancy. */
export const shotDamage = (s: ArmedStats): number =>
  s.dps * (s.shotInterval ?? COMBAT.shotInterval);

/**
 * Battlefield salvage (salvage.ts): a destroyed combat unit leaves a
 * burning wreck worth a share of its cost, scooped up by the first ground
 * unit of either side to drive over it. Fights leave loot worth holding.
 */
export const SALVAGE = {
  /** Wreck value as a share of the dead unit's cost (harvesters leave none). */
  share: 0.3,
  /** Seconds a wreck lies on the field before it burns out. */
  ttl: 60,
  /** Seconds a fresh wreck burns before it can be salvaged (not mid-brawl). */
  hot: 2.5,
  /** A ground unit whose centre comes this close (tiles) collects the wreck. */
  pickupRadius: 0.9,
  /** A death spot no tank could reach (water, rock, a building) shifts to a passable tile this close, else no wreck. */
  shiftRadius: 2,
  /** Most wrecks on the field at once; past that the oldest burns out. */
  maxWrecks: 60
};

/**
 * Commander calldowns (powers.ts). A Command meter per side (0–100) fills
 * slowly on its own and mostly from losses, and pays for three telegraphed,
 * map-targeted powers; the Sky Hammer is a separate late-game strike that
 * comes online for both sides at 6:00. Every telegraph is public (both
 * sides see it through the fog), so landing one and dodging one are both
 * skill moments. Damage stays modest and cooldowns long: burst powers fed
 * the snowball in the design panel's prototypes.
 */
export const POWERS = {
  meterMax: 100,
  /** Meter per second, always. */
  passive: 0.035,
  /** Meter per scrap of your own units and buildings destroyed (comeback-weighted). */
  perScrapLost: 0.008,
  /** Meter per scrap of enemy units and buildings you destroy. */
  perScrapKilled: 0.002,
  barrage: {
    cost: 60, cooldown: 45, telegraph: 2.5,
    /** Shells, the seconds between them, and their scatter (tiles) around the aim point. */
    shells: 3, shellGap: 0.3, scatter: 0.9,
    damage: 170, splash: 2,
    /** Reticle size: the area any shell can reach. */
    radius: 2.9
  },
  emp: {
    cost: 40, cooldown: 40, telegraph: 0.8,
    radius: 3,
    /** Seconds stunned units can't move or fire and buildings can't fire or produce. */
    stun: 4
  },
  droppod: {
    cost: 70, cooldown: 60, telegraph: 2,
    radius: 1.2,
    /** Light impact on enemy ground units right under the pod. */
    damage: 60,
    units: ["stinger", "stinger", "flak-crawler"] as UnitKind[],
    /** With a Tech Lab standing. */
    techUnits: ["lancer", "lancer", "flak-crawler"] as UnitKind[]
  },
  hammer: {
    /** Comes online for both sides at this match time (seconds), then recharges. */
    unlock: 6 * 60, cooldown: 150, telegraph: 3,
    radius: 2.5,
    /** Units: this × (1 − 0.5·d/r), any armour, ground or air. */
    unitDamage: 260,
    /** Buildings whose footprint is in the radius: flat (an HQ loses ~22%). */
    buildingDamage: 700
  },
  // ---- the nations' powers (PANACHE-CONCEPTION.md §1.7; their effects are WP1) ----
  /** Ballon-sonde (République): reveals the area, Snipers in Woods included; the balloon is seen by both sides. */
  sonde: {
    cost: 20, cooldown: 30, telegraph: 0.5,
    radius: 8,
    /** Seconds the area stays revealed. */
    duration: 20
  },
  /** Rayon Curie (République): the Sky Hammer's slot, with its own numbers. */
  curie: {
    unlock: 6 * 60, cooldown: 150, telegraph: 2.5,
    radius: 2.2,
    /** Units: this × (1 − 0.5·d/r), any armour, ground or air. */
    unitDamage: 300,
    buildingDamage: 450
  },
  /** Gaz de houille (Empire): a cloud the enemy can't see into, and can't pick targets in past `acquire` tiles. */
  gaz: {
    cost: 35, cooldown: 40, telegraph: 1,
    radius: 3.5,
    /** Seconds the cloud lasts. */
    duration: 12,
    /** An enemy unit acquires a target inside the cloud only this close (tiles). */
    acquire: 2
  },
  /** Pression des chaudières (Empire): own ground vehicles in the radius speed up and fire faster, then overheat. */
  pression: {
    cost: 45, cooldown: 55, telegraph: 0.5,
    radius: 4,
    /** Seconds of boost, then seconds of overheat (stunned). */
    duration: 10, overheat: 3,
    speed: 1.35, fireRate: 1.25
  }
};

/**
 * The four powers each side's panel shows, by nation (§1.7). The fourth is the
 * late strike (online at 6:00 like the Sky Hammer). Classique: today's four.
 */
export const POWER_SETS: Record<NationOrClassic, [PowerKind, PowerKind, PowerKind, PowerKind]> = {
  classique: ["barrage", "emp", "droppod", "hammer"],
  republique: ["sonde", "emp", "droppod", "curie"],
  empire: ["barrage", "gaz", "pression", "hammer"]
};

/**
 * The Drop Pod's crew by nation (§1.7 Obus-capsule: the République's; the
 * Empire's powers have no pod). Classique: POWERS.droppod.units / techUnits.
 */
export const POD_CREWS: Partial<Record<Nation, { units: UnitKind[]; techUnits: UnitKind[] }>> = {
  republique: { units: ["jamais-contente", "jamais-contente", "de-dion"], techUnits: ["lancer", "lancer", "de-dion"] }
};

/**
 * Map objectives (objectives.ts): capturable Uplink relays in the contested
 * middle of each map, and supply drops announced to both sides. They give
 * armies a reason to fight away from the bases and the opening a goal.
 */
export const OBJECTIVES = {
  uplink: {
    /** Capture zone radius (tiles) around the relay's centre. */
    radius: 2.5,
    /** Presence per unit in the zone (harvesters don't count); aircraft count this much. */
    airWeight: 0.5,
    /** Capture bar points per second per unit present (bar spans −100…100)… */
    perUnit: 3.5,
    /** …capped at this (4 units): neutral → owned in ~7 s, a flip in ~14 s. */
    maxRate: 14,
    /** Points per second the bar drifts back to its rest (owned: full, neutral: 0) with nobody there. */
    settle: 2,
    /** Scrap per second to the owner (× its income multiplier). */
    income: 1.5,
    /** The owner sees this far (tiles) around the relay. */
    sight: 7,
    /** Command meter per second to the owner (powers.ts). */
    charge: 0.06
  },
  drops: {
    /** Seconds into the match the first drop lands; then one every `every` seconds. */
    first: 90,
    every: 75,
    /** Seconds of public warning before a drop lands. */
    warning: 10,
    /** Seconds a landed crate waits before it burns out. */
    ttl: 45,
    /** The first non-harvester unit whose centre comes this close (tiles) claims it. */
    claimRadius: 0.8,
    /** Reward weights (both crates of a drop share the roll). */
    weights: { scrap: 38, veterans: 20, repair: 15, charge: 17, unit: 10 } as Record<string, number>,
    scrap: 200,
    /** Veterans: +1 rank to the claimer and its allies this close. */
    veteranRadius: 3,
    /** Field Repair: own units this close are healed this share of their max HP. */
    repairRadius: 4,
    repairShare: 0.5,
    /** Command meter added. */
    charge: 40,
    /** A Veterans / Repair / Charge crate that would do nothing (no one to promote or heal, meter full) pays this scrap instead. */
    fallbackScrap: 150,
    /** The rare drop: a free unit of this kind at this rank. */
    unit: "lancer" as UnitKind,
    unitRank: 1
  }
};

/** One Goliath weapon system: a weapon, and the share of max HP below which damage takes it offline. */
export interface GoliathWeaponStats extends ArmedStats {
  name: string;
  /** Offline below this share of max HP (0: never — the machine guns). */
  lostBelow: number;
}

/**
 * The Goliath (GOLIATH.md; goliath.ts, lift.ts) and its Gantry. Every number
 * here is a starting point for tuning with tools/balance.ts, not a promise.
 */
export const GOLIATH = {
  /** Each Goliath costs this much more (share of list price) for every one the side already has (alive, or on the Gantry). */
  costStep: 0.25,
  /** Goliaths a Gantry queues at once (one on the cradle). */
  queueMax: 1,
  /** Build share past which the enemy hears "Enemy Goliath nearly complete". */
  nearlyDone: 0.85,
  /** Seconds to dig in (anchor), and to pack up again: leaving under fire is the risky moment. */
  anchorTime: 4,
  packTime: 6,
  /** Footprint edge (tiles) of the ground it needs to anchor on: buildable, nothing in the way. Harvesters dock at its edge. */
  footprint: 2,
  /** Anchored: buildings may go up this far (tiles) from its centre to their footprint, as outposts. */
  buildRing: 3,
  /** Seconds a repaired weapon takes to reboot… */
  reboot: 2.5,
  /** …once HP is back this share of max above the line where it went offline (no flicker at the line). */
  restoreMargin: 0.05,
  /**
   * Weapon strength ≈ 2 Mortars, 1 Lancer, 1 Mastodon and 1 Trooper Squad
   * (≈ 1,400 scrap of firepower), lost in this order as its health falls.
   */
  weapons: {
    // two shoulder tubes taking turns: a Mortar shell every 1.5 s. (A tighter
    // burst than the Mortar's 1.1: at 1.1 a cost-equal group of Rocket Squads
    // only edged it, −0.14 in tools/balance.ts goliath duels; at 0.9, −0.39,
    // a real answer like Lancers, Wasps and Hornets, and it still beats Troopers.)
    mortars: {
      name: "Mortiers", lostBelow: 0.75,
      targets: "ground", dps: 36, range: 8, minRange: 2.5, shotInterval: 1.5,
      splash: 0.9, projectileSpeed: 5.5, dmgType: "explosive", fx: "shell"
    },
    laser: {
      name: "Arc électrique oculaire", lostBelow: 0.5,
      targets: "both", dps: 28, range: 4.5, shotInterval: 0.8, dmgType: "laser", fx: "laser", airMult: 0.65
    },
    // two arm cannons taking turns: a Mastodon's damage, half a shell at a time
    cannons: {
      name: "Canons de bras", lostBelow: 0.25,
      targets: "ground", dps: 46, range: 4, shotInterval: 0.6, dmgType: "cannon", fx: "heavy-cannon"
    },
    mg: {
      name: "Mitrailleuses", lostBelow: 0,
      targets: "both", dps: 15, range: 3, shotInterval: 0.4, dmgType: "kinetic", fx: "mg", airMult: 0.5
    }
  } as Record<"mortars" | "laser" | "cannons" | "mg", GoliathWeaponStats>,
  /** Two-Condor lift (lift.ts). */
  lift: {
    /** Lift speed as a share of the Condor's. */
    speedMult: 0.5,
    /** Dropped over land (a Condor shot down): this share of max HP in damage. Over water, sea, lava or rock: destroyed. */
    dropDamage: 0.25,
    /** Each Condor hooks on this far (tiles) to either side of the Goliath's centre. */
    span: 1.1,
    /** A Condor within this distance (tiles) of its hook point has hooked on. */
    hookRange: 0.3,
    /** A set-down point that isn't ground a Goliath can stand on snaps to the nearest that is, this far (tiles) at most. */
    setDownSearch: 6
  },
  /** A destroyed Goliath scatters this share of its list price over `piles` scrap piles across ~2×`spread` tiles. */
  salvage: { share: 0.3, piles: [6, 8] as [number, number], spread: 2.5 },
  /** A Gantry destroyed mid-build scatters this share of the scrap paid × the build's progress, in up to `piles` piles. */
  gantrySalvage: { share: 0.3, piles: 4, spread: 2.5 },
  /** Seconds a scrap pile lies before it burns out (longer than a wreck: holding the ground pays). */
  pileTtl: 90,
  /** Robot Love mutator: enemy Goliaths this close (tiles, centre to centre) fall in love, and the match is a draw. */
  love: { range: 5 },
  /** Goliath Armada mutator: the four starting Goliaths hang this far (tiles) either way of the HQ's centre, on each axis (lift.ts armadaStart). */
  armada: { gap: 2.2 }
};


// ------------------------------------------------------------- nations ---

/** One nation's economy, production and signature-mechanic numbers (§1.2). */
export interface NationStats {
  /** Display name, with its article: "la République". */
  name: string;
  /** Short name ("République") for tight spaces. */
  short: string;
  /** Scrap per unit of crystal (radium) mined (Classique: ECONOMY.crystalValue). */
  radiumValue: number;
  /** × ECONOMY.harvestRate on coal. */
  coalRate: number;
  /** Préfabriqué / Vapeur: × building cost, build time and max HP. */
  buildingCost: number;
  buildingTime: number;
  buildingHp: number;
  /** × buildTime of every unit. */
  unitTime: number;
  /** Queue items a factory builds at once (Vapeur: 2). */
  parallel: number;
  /** République — Réseau électrique: tiles from a source's centre to a building's footprint edge. */
  power?: { hqRadius: number; towerRadius: number };
  /** République — Réseau TSF: units this close to a Tour TSF or a Zénith move faster and see further. */
  tsf?: { radius: number; speed: number; sight: number };
  /** République: the Tour TSF's cost before the buildingCost multiplier (Classique 200). */
  towerCost?: number;
  /** Empire — Tranchées: still `still` s → damage taken × `mult`; at once within `redoubtRadius` of a Hotchkiss. */
  trench?: { still: number; mult: number; redoubtRadius: number };
}

/**
 * The nations (§1.2). Tunable like everything else here
 * (`--tune '{"NATIONS.republique.radiumValue":2.2}'`). Read by WP1's
 * mechanics; nothing in Classique reads them.
 */
export const NATIONS: Record<Nation, NationStats> = {
  republique: {
    name: "la République", short: "République",
    // economy
    // Classique ECONOMY.crystalValue = 1.6 (×1.25; at ×1.5 = 2.4 the radium maps — Terres fluviales,
    // Engelure — went 70–80% to the République in tools/pacing.ts --nations panels, WP4)
    radiumValue: 2.0,
    coalRate: 1.0,
    // Préfabriqué
    buildingCost: 0.85, buildingTime: 0.75, buildingHp: 0.8,
    unitTime: 0.85,
    parallel: 1,
    // Réseau électrique
    power: { hqRadius: 8, towerRadius: 7 },
    tsf: { radius: 9, speed: 1.12, sight: 2 },
    towerCost: 150
  },
  empire: {
    name: "l'Empire de Carbonie", short: "Empire",
    radiumValue: 1.6,
    coalRate: 1.15,
    buildingCost: 1.1, buildingTime: 1.15, buildingHp: 1.25,
    unitTime: 1.3,
    parallel: 2,
    // (×0.7 made dug-in Fusiliers unshiftable on the Archipelago's island relays: 16–23% for the République
    // there in tools/pacing.ts --nations panels; ×1, i.e. no trench, 46%)
    trench: { still: 3, mult: 0.9, redoubtRadius: 2.5 }
  }
};

export const NATION_IDS: Nation[] = ["republique", "empire"];

/**
 * What each nation fields (§1.3, §1.4, §1.6): its units in build-bar order
 * and its buildings. No unit is shared; building kinds are, under the
 * nation's own names (NATION_BUILDINGS), except each side's armed defences.
 */
export const ROSTERS: Record<Nation, { units: UnitKind[]; buildings: BuildingKind[] }> = {
  republique: {
    units: [
      "fourgon", "scout", "jamais-contente", "de-dion", "branly", "lancer",
      "wasp", "raptor", "hornet", "mender", "condor",
      "trooper", "sapeurs", "sniper", "zenith"
    ],
    buildings: ["hq", "fab-plant", "airpad", "tech-lab", "depot", "arsonval", "sam-site", "radar", "assembly-bay", "gantry"]
  },
  empire: {
    units: [
      "harvester", "estafette", "stinger", "flak-crawler", "mortar", "mortier-280", "mastodon", "atelier",
      "gyroptere", "epervier", "vulcain", "titan",
      "fusiliers", "rocket-squad", "carabiniers", "goliath"
    ],
    buildings: ["hq", "fab-plant", "airpad", "tech-lab", "depot", "turret", "flak-battery", "radar", "assembly-bay", "gantry"]
  }
};

/** A shared building kind's name and role under a nation (§1.6); absent: the Classique one (BUILDINGS). */
export const NATION_BUILDINGS: Record<Nation, Partial<Record<BuildingKind, { name: string; role: string }>>> = {
  republique: {
    hq: { name: "GQG", role: "Grand Quartier Général. Produit des Fourgons, reçoit le charbon, alimente le réseau. Perds-le avec tous tes Zéniths, et c'est la défaite." },
    "fab-plant": { name: "Garage électrique Jeantaud", role: "Produit les véhicules terrestres électriques." },
    "tech-lab": { name: "Polytechnique", role: "Débloque Canon Branly, Hydroglisseur, Albatros et Chasseurs alpins." },
    depot: { name: "Station de charge", role: "Point de dépôt avancé. À bâtir près des gisements éloignés." },
    radar: { name: "Tour TSF", role: "Pylône du réseau : alimente les bâtiments proches, accélère les unités, révèle une vaste zone." },
    gantry: { name: "Hangar du Zénith", role: "Construit le Zénith. Un par camp, toujours visible par l'ennemi." }
  },
  empire: {
    hq: { name: "Citadelle", role: "Citadelle impériale. Produit des Fardiers, reçoit le charbon. Perds-la avec tous tes Gargantuas, et c'est la défaite." },
    airpad: { name: "Aérodrome à vapeur", role: "Produit les aéronefs à vapeur." },
    "tech-lab": { name: "Haut-fourneau", role: "Débloque Canon de 75, Mortier de 280, Creusot, Vulcain et Carabiniers." },
    radar: { name: "Ballon captif", role: "Observatoire : révèle une vaste zone à travers le brouillard." },
    "assembly-bay": { name: "Caserne-atelier", role: "Produit l'infanterie automate impériale." }
  }
};

/**
 * The AI's roles (§1.9): which unit fills each, per nation. WP3's
 * ai/roles.ts builds on this; Classique names today's kinds, so an AI
 * reading it through the "classique" row plays exactly as before.
 */
export const ROLES: Record<NationOrClassic, Record<Role, UnitKind>> = {
  classique: {
    worker: "harvester", scout: "scout", light: "stinger", aa: "flak-crawler", artillery: "mortar", siege: "mortar",
    heavy: "mastodon", antiArmour: "lancer", airStrike: "wasp", interceptor: "raptor", bomber: "hornet",
    healer: "mender", line: "trooper", at: "rocket-squad", sniper: "sniper", transport: "condor", super: "goliath"
  },
  republique: {
    worker: "fourgon", scout: "scout", light: "jamais-contente", aa: "de-dion", artillery: "branly", siege: "branly",
    heavy: "lancer", antiArmour: "jamais-contente", airStrike: "wasp", interceptor: "raptor", bomber: "hornet",
    healer: "mender", line: "trooper", at: "sapeurs", sniper: "sniper", transport: "condor", super: "zenith"
  },
  empire: {
    worker: "harvester", scout: "estafette", light: "stinger", aa: "flak-crawler", artillery: "mortar", siege: "mortier-280",
    heavy: "mastodon", antiArmour: "mastodon", airStrike: "gyroptere", interceptor: "epervier", bomber: "vulcain",
    healer: "atelier", line: "fusiliers", at: "rocket-squad", sniper: "carabiniers", transport: "titan", super: "goliath"
  }
};

/** The Zénith's weapon systems (§1.5), lost in this order as its health falls. */
export type ZenithWeapon = "branly" | "arc" | "bombs" | "mg";

/**
 * The Zénith (§1.5): the République's super-unit, an airborne Goliath. WP2
 * generalises goliath.ts over this and GOLIATH.
 */
export const ZENITH = {
  /** Each Zénith costs this much more (share of list price) for every one the side already has. */
  costStep: 0.25,
  queueMax: 1,
  nearlyDone: 0.85,
  /** Seconds to moor (over buildable 2×2 ground), and to cast off again. */
  anchorTime: 3,
  packTime: 4,
  footprint: 2,
  buildRing: 3,
  reboot: 2.5,
  restoreMargin: 0.05,
  /** Moored, it trains these (instead of the Goliath's infantry). */
  trains: ["wasp", "raptor", "mender", "scout"] as UnitKind[],
  /** Only these repair it. */
  repairedBy: ["mender"] as UnitKind[],
  weapons: {
    branly: {
      name: "Canons Branly de nacelle", lostBelow: 0.75,
      targets: "ground", dps: 30, range: 7, minRange: 2.5, shotInterval: 2,
      splash: 0.8, projectileSpeed: 9, dmgType: "explosive", fx: "arc-shell"
    },
    arc: {
      name: "Arc de proue", lostBelow: 0.5,
      targets: "both", dps: 26, range: 5, shotInterval: 0.8, dmgType: "laser", fx: "laser", airMult: 0.8
    },
    bombs: {
      name: "Soute à bombes", lostBelow: 0.25,
      targets: "ground", dps: 34, range: 2, shotInterval: 2,
      splash: 1.2, projectileSpeed: 5, dmgType: "explosive", fx: "bomb"
    },
    mg: {
      name: "Mitrailleuses de coursive", lostBelow: 0,
      targets: "both", dps: 15, range: 3.5, shotInterval: 0.4, dmgType: "kinetic", fx: "mg", airMult: 0.7
    }
  } as Record<ZenithWeapon, GoliathWeaponStats>
};
