export type Faction = "blue" | "red";

/**
 * A nation (PANACHE-CONCEPTION.md §1): the "race" a side plays, with its own
 * roster, economy and powers. Independent of the side (Faction: the seat).
 * A match without nations is Classique: the 16 shared units, symmetric.
 */
export type Nation = "republique" | "empire";
/** A nation, or "classique" (no nation: today's symmetric rules). */
export type NationOrClassic = Nation | "classique";

/** What a unit does in an army (§1.9): the AI names roles, each nation fills them with its own kinds. */
export type Role =
  | "worker" | "scout" | "light" | "aa" | "artillery" | "siege" | "heavy" | "antiArmour" | "airStrike"
  | "interceptor" | "bomber" | "healer" | "line" | "at" | "sniper" | "transport" | "super";
export type Domain = "ground" | "air";
export type TargetDomain = "ground" | "air" | "both" | "none";

/** The 16 units of Classique (and their order: indices elsewhere depend on it). */
export type ClassicUnitKind =
  | "harvester"
  | "scout"
  | "stinger"
  | "flak-crawler"
  | "mortar"
  | "mastodon"
  | "lancer"
  | "wasp"
  | "raptor"
  | "hornet"
  | "mender"
  // robot infantry (INFANTRY.md): each is ONE sim unit drawn as UNITS[kind].squad robots
  | "trooper"
  | "rocket-squad"
  | "sniper"
  /** Dropship: carries two infantry squads, unarmed. */
  | "condor"
  /**
   * Giant walking mech and mobile base (GOLIATH.md, goliath.ts): four weapon
   * systems it loses as it takes damage, and anchored, a drop-off, a build
   * ring and infantry training. Built at the Gantry.
   */
  | "goliath";

/**
 * Units only a nation fields (PANACHE-CONCEPTION.md §1.5): banned in
 * Classique and for the other nation. Each may point at a base behaviour
 * (`UnitStats.base`).
 */
export type NationUnitKind =
  // République
  | "fourgon"
  | "jamais-contente"
  | "de-dion"
  | "branly"
  | "sapeurs"
  | "zenith"
  // Empire de Carbonie
  | "estafette"
  | "mortier-280"
  | "gyroptere"
  | "epervier"
  | "vulcain"
  | "atelier"
  | "fusiliers"
  | "carabiniers"
  | "titan";

export type UnitKind = ClassicUnitKind | NationUnitKind;

export type ClassicBuildingKind =
  | "hq"
  | "fab-plant"
  | "airpad"
  | "tech-lab"
  | "depot"
  | "turret"
  | "sam-site"
  | "radar"
  /** Builds robot infantry. */
  | "assembly-bay"
  /** Top of the tree: builds the Goliath (one per side, always visible to the enemy). */
  | "gantry";

/** Armed defences only one nation builds (§1.6): the République's arc tower, the Empire's AA battery. */
export type NationBuildingKind = "arsonval" | "flak-battery";

export type BuildingKind = ClassicBuildingKind | NationBuildingKind;

/** Armor classes: weapons deal a damage-type-specific multiple vs each. */
export type ArmorClass = "light" | "medium" | "heavy" | "structure" | "infantry";

/** Damage types, each with a multiplier row in `DAMAGE_VS` (balance.ts). */
export type DamageType = "kinetic" | "cannon" | "flak" | "missile" | "explosive" | "laser" | "precision";

/** How a weapon looks when it fires (render-only hint carried on fx). */
export type WeaponFx =
  | "cannon"
  | "heavy-cannon"
  | "flak"
  | "rockets"
  | "missile"
  | "laser"
  | "shell"
  | "bomb"
  | "mg"
  /** Trooper rifles: a crackle of light tracers from each robot standing. */
  | "rifle"
  /** Sniper rail-rifle: one bright, instant streak. */
  | "snipe"
  /** Canon Branly: a glowing blue electromagnetic shell (§1.11; drawn as "shell" until its own fx). */
  | "arc-shell"
  /** Mortier de 280: a huge, slow siege shell (§1.11; drawn as "shell" until its own fx). */
  | "heavy-shell";

export const enum Terrain {
  Ground = 0,
  Rock = 1,
  Scrap = 2,
  /** Deep water (or lava): blocks tracked/wheeled units; hover and air cross. */
  Water = 3,
  /** Paved road: faster ground movement. */
  Road = 4,
  /** Mud, scree, slush: slow for wheels/tracks, hover glides over. */
  Rough = 5,
  /** Woods: slow for everyone on the ground, and cover (less damage taken). */
  Forest = 6,
  /** Rich crystal field: harvests into more scrap per load. */
  Crystal = 7,
  /** Bridge deck over water: a road that can't be built on. */
  Bridge = 8,
  /** Shallow ford: slow for ground units, open to hover. */
  Shallows = 9,
  /** Open sea: too deep and rough for anything but aircraft (hover included). */
  Deep = 10
}

/** Harvester internal cycle state. */
export type HarvestPhase = "toField" | "harvesting" | "toBase" | "unloading";

export type UnitOrder =
  | { type: "idle" }
  | { type: "move"; x: number; y: number }
  | { type: "attackMove"; x: number; y: number }
  | { type: "attack"; targetId: number }
  | { type: "harvest"; fieldX: number; fieldY: number; phase: HarvestPhase }
  /**
   * Infantry: walk to Condor `carrierId` and climb aboard (transport.ts).
   * `ticks` counts up while the squad is within boarding range; at
   * INFANTRY.boardTime it is taken off the map into the Condor.
   */
  | { type: "board"; carrierId: number; ticks: number }
  /**
   * Condor: fly to (x, y) — already snapped to the nearest tile infantry can
   * stand on — hover for INFANTRY.unloadHover, then drop every passenger.
   * `hover` is -1 while flying, then counts ticks spent hovering.
   */
  | { type: "unload"; x: number; y: number; hover: number }
  /**
   * Condor: one of the two carrying Goliath `goliathId` (lift.ts). The lift
   * moves it; tickMovement leaves it alone.
   */
  | { type: "lift"; goliathId: number };

/** The Goliath's weapon systems (goliath.ts). The machine guns never go offline. */
export type GoliathWeapon = "mortars" | "laser" | "cannons" | "mg";

/** Walking ⇄ anchored, through the timed transitions between them (goliath.ts). */
export type GoliathMode = "walking" | "anchoring" | "anchored" | "packing";

export interface GoliathWeaponState {
  /** Firing. False while lost to damage, and through the reboot that brings it back. */
  online: boolean;
  /** Ticks left of the reboot that brings it back online (−1: not rebooting). */
  reboot: number;
  /** Ticks until this weapon may fire again. */
  cooldown: number;
  /** What it is shooting at (picked per weapon), or null. */
  targetId: number | null;
  /** Tick it last fired (renderer: recoil, muzzle flash). */
  firedTick: number;
}

/** Two Condors carrying a walking Goliath (lift.ts). */
export interface GoliathLift {
  /** The two Condors (each on a `lift` order naming this Goliath). */
  carriers: [number, number];
  /** "hooking": the Condors are flying in to hook on; "carrying": it is off the ground. */
  phase: "hooking" | "carrying";
  /** Where the lift is flying (null: hovering where it is). */
  dest: { x: number; y: number } | null;
  /** On arrival at `dest`, set the Goliath down (else hover there). */
  setDown: boolean;
}

/** Everything a Goliath carries beyond a plain unit (Unit.goliath; goliath.ts). */
export interface GoliathState {
  mode: GoliathMode;
  /** Ticks left of an anchoring or packing transition (0 once settled). */
  modeTicks: number;
  weapons: Record<GoliathWeapon, GoliathWeaponState>;
  /** Infantry training queue: advances only while anchored. */
  queue: QueueItem[];
  rally: { x: number; y: number } | null;
  /** Two Condors hooking on or carrying it, or null. */
  lift: GoliathLift | null;
  /**
   * Dug in (anchoring, anchored or packing up): the top-left tile of the
   * GOLIATH.footprint² it stands on, stamped with its id in World.occupancy
   * so paths go round it like a building. null while it walks.
   */
  foot: { tx: number; ty: number } | null;
}

export interface Unit {
  id: number;
  kind: UnitKind;
  faction: Faction;
  /** Position in tile units (floats); the unit's centre. */
  x: number;
  y: number;
  hp: number;
  /** Hull facing angle in radians, 0 = North (up), clockwise. */
  facing: number;
  /** Weapon aim angle (turrets track this independently of the hull). */
  aim: number;
  order: UnitOrder;
  /** Remaining path waypoints in tile coords (ground units). */
  path: { x: number; y: number }[] | null;
  /** Destination the current path was computed for (invalidation check). */
  pathGoal: { x: number; y: number } | null;
  /** Scrap carried (harvesters). */
  cargo: number;
  /** Ticks until this unit may fire again. */
  cooldown: number;
  /** Current auto-acquired target while attack-moving/idling. */
  autoTargetId: number | null;
  /** Tick this unit last took damage (drives harvester flee behaviour). */
  damagedTick: number;
  /** Who last hurt us (unit or building id) — idle units retaliate. */
  lastAttackerId: number | null;
  /** Tick this unit last fired (renderer: recoil, turret settle). */
  firedTick: number;
  /** Combat experience: scrap value of enemies destroyed. */
  xp: number;
  /** Veterancy rank 0–3 (derived from xp); boosts damage. */
  rank: number;
  /** Enemy units and buildings this unit has destroyed. */
  kills: number;
  /**
   * Condor only: the infantry squads aboard (at most INFANTRY.capacity).
   * Passengers are taken OUT of `World.units` while aboard — hidden, unable
   * to fire, no vision, no presence — and put back (same id) when dropped.
   * Absent on every other unit.
   */
  passengers?: Unit[];
  /**
   * A target this unit found it can't get in range of (across the water), left
   * alone until `until` (tick) so it fights what it can reach meanwhile.
   */
  ignore?: { id: number; until: number };
  /**
   * Handed out by the map, not bought: the island map's starting Condor and
   * the free replacement Condor with its squad (lifeline.ts). A free unit
   * leaves no wreck and its loss charges no one's ⚡ meter, so throwing one
   * away gains nothing.
   */
  free?: boolean;
  /** Goliath only: its modes, weapon systems, training queue and lift (goliath.ts). Absent on every other unit. */
  goliath?: GoliathState;
  /**
   * Waypoints queued behind the unit's move or attack-move (route.ts): a
   * route drawn on the map, or a patrol. Absent when there are none.
   */
  route?: UnitRoute;
  /**
   * On its way to its place in a march in order (march.ts): its group
   * (World.marches), the tick it is due there, and the way it faces once
   * there. Absent when it isn't marching.
   */
  march?: { g: number; due: number; face: number };
  /** Its skill's clocks (skills.ts); absent until it first uses one. */
  skill?: SkillState;
}

/** A unit skill (skills.ts). */
export type SkillId = "bayonet" | "throttle" | "battery" | "snipe" | "charge" | "barrage";

/** A unit's skill clocks (Unit.skill, skills.ts). */
export interface SkillState {
  /** The tick it can be used again. */
  ready: number;
  /** A timed skill runs until this tick. */
  until: number;
  /** A French 75's battery: off, getting in, in, getting out. */
  battery: "off" | "deploying" | "on" | "packing";
  /** The tick a deploy or pack-up ends. */
  shift: number;
  /** A snipe waiting to be in reach: its target. */
  snipe: number | null;
}

/** Legs still to go after the current move or attack-move (route.ts). */
export interface UnitRoute {
  /** The next points, in order. */
  pts: { x: number; y: number }[];
  /** Plain moves (the route began with a move: ⚑ Repli), else attack-moves. */
  move: boolean;
  /** A patrol: each point reached goes back on the end, so the unit goes round for ever. */
  loop: boolean;
}

export interface QueueItem {
  kind: UnitKind;
  /** Ticks of build time remaining. */
  remaining: number;
  /** Scrap paid, when it isn't the kind's list price (a Goliath's escalating cost): what a cancel refunds. */
  paid?: number;
}

export interface Building {
  id: number;
  kind: BuildingKind;
  faction: Faction;
  /** Top-left tile of the footprint. */
  tx: number;
  ty: number;
  hp: number;
  queue: QueueItem[];
  rally: { x: number; y: number } | null;
  /** Turret head facing, radians clockwise from North. */
  facing: number;
  cooldown: number;
  damagedTick: number;
  lastAttackerId: number | null;
  firedTick: number;
  /**
   * Placed in the build ring of an anchored Goliath, out of normal build range
   * (goliath.ts). It works like any other building, but never counts as base
   * for build range: nothing can be built off it. Decided when it is placed.
   */
  outpost?: boolean;
}

/** A building being constructed C&C-style (timer in the "sidebar"). */
export interface PendingBuilding {
  kind: BuildingKind;
  remaining: number;
  ready: boolean;
}

export interface FactionStats {
  unitsBuilt: number;
  unitsLost: number;
  unitsKilled: number;
  buildingsLost: number;
  /** Enemy buildings destroyed (by anything this faction owns). */
  buildingsKilled: number;
  scrapHarvested: number;
  /** Scrap collected from battlefield wrecks (salvage.ts). */
  scrapSalvaged: number;
}

export interface FactionState {
  scrap: number;
  /** At most one building under construction at a time (C&C rule). */
  pending: PendingBuilding | null;
  stats: FactionStats;
  /** Multiplier on harvested scrap (AI difficulty handicap/bonus). */
  incomeMult: number;
}

/** A simulated slow projectile (artillery shell, bomb): dodgeable. */
export interface Projectile {
  id: number;
  faction: Faction;
  fx: WeaponFx;
  /** Launch point, current point, and ground impact point (tiles). */
  sx: number;
  sy: number;
  x: number;
  y: number;
  tx: number;
  ty: number;
  /** Tiles per tick. */
  speed: number;
  damage: number;
  splash: number;
  dmgType: DamageType;
  targets: TargetDomain;
  sourceId: number;
  /** Launched from the air (bombs fall rather than arc). */
  fromAir: boolean;
}

export type FxEvent =
  | {
      type: "shot";
      fx: WeaponFx;
      x: number;
      y: number;
      tx: number;
      ty: number;
      /** Shooter / target are airborne (for render altitude). */
      fromAir: boolean;
      air: boolean;
      sourceId: number;
    }
  | { type: "explosion"; x: number; y: number; size: number; air: boolean; kind: "unit" | "building" | "impact" }
  | { type: "heal"; x: number; y: number; tx: number; ty: number; sourceId: number; targetId: number }
  | { type: "built"; faction: Faction; id: number }
  | { type: "sold"; id: number }
  | {
      type: "hit";
      /** Victim's faction, id and position. */
      faction: Faction;
      id: number;
      x: number;
      y: number;
      building: boolean;
      /** Who dealt the damage (may already be dead next tick). */
      attackerId: number;
    }
  | { type: "rankUp"; id: number }
  | {
      /**
       * Something was destroyed. Emitted once per death alongside the
       * visual "explosion" event, with everything feedback, stats and
       * awards need (the entity is already gone from the world).
       */
      type: "death";
      id: number;
      /** The victim's faction; the kill is credited to the other one. */
      faction: Faction;
      unitKind: UnitKind | null;
      buildingKind: BuildingKind | null;
      x: number;
      y: number;
      air: boolean;
      /** Scrap value of what died (HQs count 500). */
      value: number;
      /** Killer unit/building id if it is still alive this tick, else null. */
      killerId: number | null;
      /** The killer's unit kind, when the killer is a living unit. */
      killerKind: UnitKind | null;
      /** Victim's veterancy rank and kill count at death (0 for buildings). */
      rank: number;
      kills: number;
      /** A map-given unit (Unit.free): its loss charges no ⚡ meter. */
      free?: boolean;
    }
  | {
      /** A harvester started unloading `amount` scrap at a drop-off. */
      type: "deposit";
      faction: Faction;
      id: number;
      x: number;
      y: number;
      amount: number;
    }
  | {
      /** Last Stand: wave `wave` lands in `eta` ticks at (x, y), entering from `dir`. */
      type: "waveIncoming";
      wave: number;
      theme: WaveTheme;
      name: string;
      x: number;
      y: number;
      dir: string;
      eta: number;
      /** Scrap paid because the defender called this wave early (0 if not). */
      early: number;
    }
  | { type: "waveSpawned"; wave: number; theme: WaveTheme; name: string; x: number; y: number; count: number }
  | {
      /** Last Stand: every wave unit is dead; the defender got `bonus` scrap. */
      type: "waveCleared";
      wave: number;
      bonus: number;
      next: string;
      nextTheme: WaveTheme;
    }
  | {
      /** A ground unit scooped up a wreck: `value` scrap (after incomeMult) went to `faction`. */
      type: "salvage";
      faction: Faction;
      x: number;
      y: number;
      value: number;
      wreckId: number;
      /** The collecting unit (or the building placed on top of the wreck). */
      collectorId: number;
    }
  | {
      /**
       * A commander calldown was fired (powers.ts). Public: both sides see
       * the telegraph through the fog. It lands at `landTick`.
       */
      type: "calldown";
      id: number;
      faction: Faction;
      power: PowerKind;
      x: number;
      y: number;
      radius: number;
      landTick: number;
    }
  | {
      /**
       * A calldown landed: one per Barrage shell; the EMP pulse; the Drop
       * Pod touching down (`unitIds` = its crew); the Sky Hammer strike.
       * `hits` = enemy units and buildings it damaged or stunned.
       */
      type: "calldownImpact";
      id: number;
      faction: Faction;
      power: PowerKind;
      x: number;
      y: number;
      radius: number;
      hits: number;
      unitIds: number[];
    }
  | {
      /** EMP: these entities (of `faction`) can't move, fire or produce until `until`. */
      type: "stun";
      faction: Faction;
      ids: number[];
      x: number;
      y: number;
      until: number;
    }
  | {
      /** A power just came online for `faction` (the Sky Hammer at 6:00). */
      type: "powerOnline";
      faction: Faction;
      power: PowerKind;
    }
  | {
      /**
       * An Uplink changed hands (objectives.ts): `owner` took it (from
       * neutral), or `owner` is null when `prev` lost it to a neutralising
       * push by `by`. Public: both sides see it.
       */
      type: "uplinkFlip";
      id: number;
      x: number;
      y: number;
      owner: Faction | null;
      prev: Faction | null;
      by: Faction;
    }
  | {
      /** `faction` started pushing an Uplink's capture bar its way (fires once per push). */
      type: "uplinkContest";
      id: number;
      x: number;
      y: number;
      faction: Faction;
      /** Owner at the moment the push began. */
      owner: Faction | null;
    }
  | {
      /** A supply crate was announced (public, both sides): it lands at `landTick`. */
      type: "crateIncoming";
      id: number;
      x: number;
      y: number;
      reward: CrateReward;
      landTick: number;
      /** Which drop of the match (0 = the first); both crates of a drop share it. */
      drop: number;
    }
  | { type: "crateLanded"; id: number; x: number; y: number; reward: CrateReward }
  | {
      /**
       * `faction` claimed a crate. `amount`: scrap or charge gained, units
       * promoted or healed; `unitIds`: the units it affected (or the one it
       * delivered).
       */
      type: "crateClaimed";
      id: number;
      x: number;
      y: number;
      faction: Faction;
      collectorId: number;
      reward: CrateReward;
      amount: number;
      unitIds: number[];
      /** Scrap credited (the scrap reward, or the fallback when a kit had nothing to work on). */
      scrap: number;
    }
  | { type: "crateExpired"; id: number; x: number; y: number }
  | {
      /** A free replacement Condor `id` flew in at (x, y) (lifeline.ts), `squad`: with a free squad aboard. */
      type: "lifeline";
      faction: Faction;
      id: number;
      x: number;
      y: number;
      squad: boolean;
    }
  | {
      /** Infantry squad `unitId` climbed into Condor `carrierId` (it left World.units). */
      type: "embark";
      faction: Faction;
      carrierId: number;
      unitId: number;
      x: number;
      y: number;
    }
  | {
      /**
       * Condor `carrierId` put squads `unitIds` back on the ground at (x, y):
       * a normal drop, or `bailout` when it was shot down (they land hurt).
       */
      type: "disembark";
      faction: Faction;
      carrierId: number;
      unitIds: number[];
      x: number;
      y: number;
      bailout: boolean;
    }
  | {
      /** A Mastodon rolled over enemy squad `id` this tick (crushing, INFANTRY.crushDps). */
      type: "crush";
      faction: Faction;
      id: number;
      attackerId: number;
      x: number;
      y: number;
    }
  | {
      /**
       * A Gantry's Goliath build (public: both sides hear it): `started` as a
       * build begins, `nearlyDone` as it passes GOLIATH.nearlyDone.
       */
      type: "goliathBuild";
      faction: Faction;
      buildingId: number;
      stage: "started" | "nearlyDone";
      x: number;
      y: number;
    }
  | {
      /** Goliath `id` walked off its Gantry `buildingId` (public). */
      type: "goliathRollout";
      faction: Faction;
      id: number;
      buildingId: number;
      x: number;
      y: number;
    }
  | {
      /** Goliath `id` entered `mode`: anchoring (digging in), anchored, packing (up), walking (free to move). */
      type: "goliathMode";
      faction: Faction;
      id: number;
      mode: GoliathMode;
      x: number;
      y: number;
    }
  | {
      /** A Goliath weapon system went `offline` (damage), started `rebooting` (repaired), or came back `online`. */
      type: "goliathWeapon";
      faction: Faction;
      id: number;
      weapon: GoliathWeapon;
      state: "offline" | "rebooting" | "online";
      x: number;
      y: number;
    }
  | {
      /**
       * Two Condors `carrierIds` and Goliath `id` (lift.ts): `hooked` (it left
       * the ground), `setDown` (put down on purpose), or `dropped` (a Condor
       * was lost): it fell, `destroyed` over water, sea, lava or rock.
       */
      type: "goliathLift";
      faction: Faction;
      id: number;
      carrierIds: number[];
      state: "hooked" | "setDown" | "dropped";
      x: number;
      y: number;
      destroyed?: boolean;
    }
  | {
      /**
       * Robot Love: enemy Goliaths `ids` (blue's, red's) came within
       * GOLIATH.love.range of each other and fell in love; the match ends in
       * a draw this tick. (x, y) is the point between them, where they meet.
       */
      type: "love";
      ids: [number, number];
      x: number;
      y: number;
    }
  /** `faction` resigned (a duel): the other side wins this tick. */
  | { type: "resign"; faction: Faction }
  /** Éclair (modes/eclair.ts): the last minute began, sudden death began, or Éclair decided the match this tick. */
  | { type: "eclair"; phase: "rush" | "overtime" | "end" }
  /** Unit `id` used its skill (skills.ts): a battery's deploy or pack-up, a snipe's shot, the rest as they start. */
  | { type: "skill"; id: number; skill: SkillId };

/**
 * A capturable Uplink relay (objectives.ts). Not a building: nothing
 * occupies its tiles and nothing can shoot it, so combat never sees it.
 */
export interface Uplink {
  id: number;
  /** Centre of the capture zone, in tiles. */
  x: number;
  y: number;
  owner: Faction | null;
  /** Capture bar: −100 (red holds it) … 0 (neutral) … +100 (blue holds it). */
  progress: number;
  /** Who is pushing the bar right now (null: nobody, or contested). */
  pushing: Faction | null;
  /** Both sides are inside the zone (the bar is frozen). */
  contested: boolean;
  /**
   * An island relay: only robot infantry count in its zone, to take it AND to
   * contest it (aircraft, the Condor and vehicles don't), and it pays only
   * while the holder's infantry stand in it ("crewed"). Set by the map.
   */
  infantryOnly?: boolean;
  /** Scrap per second to the holder (default OBJECTIVES.uplink.income). */
  income?: number;
  /** ⚡ meter per second to the holder (default OBJECTIVES.uplink.charge). */
  charge?: number;
  /** Infantry-only relays: the holder has a squad in the zone this tick, so it pays. */
  crewed?: boolean;
}

/** What a supply crate holds (the same for both crates of a drop: fair). */
export type CrateReward = "scrap" | "veterans" | "repair" | "charge" | "unit";

export interface Crate {
  id: number;
  x: number;
  y: number;
  reward: CrateReward;
  drop: number;
  /** Announced at, lands (claimable from) at, and burns out at, in ticks. */
  announcedTick: number;
  landTick: number;
  expireTick: number;
}

export interface ObjectiveState {
  uplinks: Uplink[];
  /** Announced or landed crates not yet claimed or expired. */
  crates: Crate[];
  /** Supply-drop sites (tiles, blue-side; each drop lands a crate here and at the mirror). Empty = no drops. */
  dropSites: { x: number; y: number }[];
  /** Drops announced so far (the next drop's index). */
  drops: number;
  /** Index into `dropSites` of the last drop (the next one lands elsewhere). */
  lastSite: number;
  /** Per side: scrap from Uplinks and crates, captures, crates claimed. */
  stats: Record<Faction, { uplinkScrap: number; crateScrap: number; captures: number; crates: number }>;
}

/**
 * What a destroyed combat unit leaves behind (salvage.ts): a burning hull
 * worth scrap to whichever side's ground unit reaches it first. Wrecks are
 * pure loot: they never block movement or placement.
 */
export interface Wreck {
  /** The dead unit's id (ids are never reused, so this is unique). */
  id: number;
  kind: UnitKind;
  /** Whose unit it was (the renderer tints the hull; anyone may salvage it). */
  faction: Faction;
  /** Resting position (tiles): where it died, or nudged onto passable ground. */
  x: number;
  y: number;
  /** Hull facing at death, radians clockwise from North. */
  facing: number;
  /** Scrap it is worth before the collector's incomeMult. */
  value: number;
  /** Ticks left before it burns out. */
  ttl: number;
  /** Ticks left while it is still too hot to salvage. */
  hot: number;
  /**
   * A scrap pile, not a hull: one of the piles a fallen Goliath scatters, or
   * a half-built one strewn around its destroyed Gantry (goliath.ts). `kind`
   * is "goliath"; its `id` is fresh (several piles share one dead unit).
   */
  pile?: boolean;
}

/** Commander calldowns (powers.ts): three on the Command meter plus the late-game Sky Hammer. */
export type ClassicPowerKind = "barrage" | "emp" | "droppod" | "hammer";
/**
 * The nations' own powers (§1.7): Ballon-sonde and Rayon Curie (République),
 * Gaz de houille and Pression des chaudières (Empire).
 */
export type NationPowerKind = "sonde" | "curie" | "gaz" | "pression";
export type PowerKind = ClassicPowerKind | NationPowerKind;

/** A calldown in flight: telegraphed from `startTick`, landing at `landTick`. */
export interface Calldown {
  id: number;
  faction: Faction;
  power: PowerKind;
  x: number;
  y: number;
  radius: number;
  startTick: number;
  landTick: number;
  /** Barrage: where and when each shell lands (seeded scatter). */
  shells: { x: number; y: number; tick: number }[];
}

export interface PowerState {
  /** Command meter per side, 0–POWERS.meterMax. */
  meter: Record<Faction, number>;
  /** Tick each power is next usable, per side (the Sky Hammer starts locked). */
  readyAt: Record<Faction, Record<PowerKind, number>>;
  /** Telegraphed calldowns not yet resolved (public information). */
  active: Calldown[];
  /** EMP'd entity id → tick the stun wears off. */
  stunned: Map<number, number>;
  /** Calldowns fired per side and power (stats). */
  fired: Record<Faction, Record<PowerKind, number>>;
}

import type { FactionFog } from "./fog";
import type { SurvivalState, WaveTheme } from "./modes/survival";
import type { Rules } from "./rules";
import type { OpsState } from "./ops";

export type Biome = "temperate" | "desert" | "arctic" | "volcanic" | "tropical";

export interface World {
  tick: number;
  width: number;
  height: number;
  terrain: Uint8Array;
  /** Scrap remaining per tile (only meaningful on scrap/crystal tiles). */
  scrap: Uint16Array;
  /** Building id occupying each tile (0 = none) — O(1) footprint lookups. */
  occupancy: Int32Array;
  nextId: number;
  units: Map<number, Unit>;
  buildings: Map<number, Building>;
  projectiles: Projectile[];
  /** Salvageable wrecks on the field, oldest first. */
  wrecks: Wreck[];
  /** Commander meters, cooldowns, calldowns in flight and EMP stuns (powers.ts). */
  powers: PowerState;
  /** Map objectives: Uplink relays and supply drops (objectives.ts). Empty unless the match enables them. */
  objectives: ObjectiveState;
  factions: Record<Faction, FactionState>;
  /**
   * null while the match runs; then the winning faction (once a side has lost
   * its HQ and every Goliath), or "draw" (Robot Love: two enemy Goliaths fell
   * in love, goliath.ts tickLove). Anything that only asks "is it over?" can
   * test it for truthiness.
   */
  winner: Faction | "draw" | null;
  /** Transient render events emitted this tick (cleared each step). */
  fx: FxEvent[];
  fog: Record<Faction, FactionFog>;
  /** Map metadata for the renderer. */
  mapId: string;
  biome: Biome;
  /**
   * Per-match seed. All sim randomness must derive from this (see rand.ts),
   * never Math.random, so a match replays identically from its commands.
   */
  seed: number;
  /** Last Stand (survival mode) wave director state; absent in skirmish. */
  survival?: SurvivalState | null;
  /** Match mutators (rules.ts); absent = classic rules. Read via rulesOf(w). */
  rules?: Rules | null;
  /** Ops campaign scenario state (ops.ts); absent in skirmish and Last Stand. */
  ops?: OpsState | null;
  /** Free replacement Condors (lifeline.ts); absent unless the map hands them out. */
  lifeline?: Record<Faction, LifelineSlot> | null;
  /** Robot Love: the two Goliaths that fell in love and ended the match in a draw, where and when (goliath.ts tickLove). */
  love?: { ids: [number, number]; x: number; y: number; tick: number } | null;
  /** The side that resigned, when a `resign` command decided the match. */
  resigned?: Faction | null;
  /** Éclair (modes/eclair.ts): the points and the clock's phase; absent unless the match plays the mutator. */
  eclair?: EclairState;
  /** Marches in order just given (march.ts), kept a moment so a later piece of the same order joins them; absent when none. */
  marches?: MarchGroup[];
}

/** An Éclair match's state (World.eclair, modes/eclair.ts). */
export interface EclairState {
  /** Victory points: destructions (the cost of what the other side lost) and Uplinks held. */
  points: Record<Faction, number>;
  /** The share of `points` the Uplinks brought (the rest is destructions). */
  relays: Record<Faction, number>;
  /** "play" until the last minute, "rush" in it, "overtime" in sudden death, "over" once decided (by anything). */
  phase: "play" | "rush" | "overtime" | "over";
  /** How Éclair decided it (null: it didn't, or not yet): on points at the whistle, by sudden death, or on points when sudden death ran out. */
  decided: "points" | "sudden" | "time" | null;
  /** The points as sudden death began (null before it). */
  at: Record<Faction, number> | null;
}

/** A march in order just given (World.marches, march.ts): kept MARCH.mergeTicks so a later piece of the same order joins it. */
export interface MarchGroup {
  id: number;
  faction: Faction;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  attack: boolean;
  /** The tick it was given. */
  tick: number;
  /** Its units, in id order. */
  units: number[];
}

/** One side's free-Condor clock (lifeline.ts). */
export interface LifelineSlot {
  /** Tick the replacement flies in (null: the side has a Condor, or none is owed). */
  due: number | null;
  /** Free Condors handed out so far. */
  given: number;
}

export type Command =
  | { type: "move"; faction: Faction; unitIds: number[]; x: number; y: number }
  | { type: "attackMove"; faction: Faction; unitIds: number[]; x: number; y: number }
  | { type: "attack"; faction: Faction; unitIds: number[]; targetId: number }
  | { type: "harvest"; faction: Faction; unitIds: number[]; x: number; y: number }
  | { type: "stop"; faction: Faction; unitIds: number[] }
  /** `buildingId`: a production building, or an anchored Goliath's unit id (it trains infantry, goliath.ts). */
  | { type: "produce"; faction: Faction; buildingId: number; unit: UnitKind }
  | { type: "cancelProduce"; faction: Faction; buildingId: number; unit: UnitKind }
  | { type: "startBuilding"; faction: Faction; building: BuildingKind }
  | { type: "cancelBuilding"; faction: Faction }
  | { type: "placeBuilding"; faction: Faction; tx: number; ty: number }
  | { type: "sell"; faction: Faction; buildingId: number }
  | { type: "rally"; faction: Faction; buildingId: number; x: number; y: number }
  /** Last Stand: bring the next wave in now for a scrap bonus. */
  | { type: "callWave"; faction: Faction }
  | { type: "calldown"; faction: Faction; power: PowerKind; x: number; y: number }
  /** Infantry `unitIds` board Condor `carrierId` (the Condor comes to meet them if idle). */
  | { type: "board"; faction: Faction; unitIds: number[]; carrierId: number }
  /**
   * Condors `unitIds` drop their passengers: at (x, y) if given (they fly there
   * first; the drop snaps to the nearest tile infantry can stand on), else
   * right where they are.
   */
  | { type: "unload"; faction: Faction; unitIds: number[]; x?: number; y?: number }
  /** Goliaths `unitIds` dig in where they stand (goliath.ts anchorBlocker says where they can't). */
  | { type: "anchor"; faction: Faction; unitIds: number[] }
  /** Anchored (or anchoring) Goliaths `unitIds` pack up to walk again. */
  | { type: "packUp"; faction: Faction; unitIds: number[] }
  /**
   * Two empty Condors `unitIds` hook onto walking Goliath `goliathId` and lift
   * it (lift.ts). Then `move` flies the lift, `unload` sets it down (at x, y
   * if given) and `stop` hovers it.
   */
  | { type: "lift"; faction: Faction; unitIds: number[]; goliathId: number }
  /** `faction` gives up: the other side wins on this tick (a duel's Resign, DUEL.md). */
  | { type: "resign"; faction: Faction }
  /**
   * Queue (x, y) behind each unit's move or attack-move, of the same kind; a
   * unit on neither sets off for it now (route.ts). A route drawn on the map
   * is a move or attackMove to its first point, then one of these per point.
   */
  | { type: "waypoint"; faction: Faction; unitIds: number[]; x: number; y: number }
  /**
   * Patrol: queue (x, y) like a waypoint, then go round the route for ever,
   * attack-moving. A unit with no move under way patrols between where it
   * stands and (x, y) (route.ts).
   */
  | { type: "patrol"; faction: Faction; unitIds: number[]; x: number; y: number }
  /**
   * March in order to the front drawn from (x1, y1) to (x2, y2) (march.ts):
   * each unit to its place by what it does, all arriving together; an
   * attack-move (`attack`), else a plain move.
   */
  | { type: "march"; faction: Faction; unitIds: number[]; x1: number; y1: number; x2: number; y2: number; attack: boolean }
  /** Units `unitIds` use their skill `skill` (skills.ts); a snipe names its target. */
  | { type: "skill"; faction: Faction; unitIds: number[]; skill: SkillId; targetId?: number };
