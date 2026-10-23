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
import { tr } from "./lang";

const fmt = (n: number): string => String(Math.round(n * 100) / 100).replace(".", tr(",", "."));
const NB = tr("\u00a0", "");

export const FEATURES: Record<UnitKind, string[]> = {
  harvester: [
    tr("Ton économie : il rejoint le gisement de charbon ou de radium le plus proche, remplit sa benne et rapporte le tout au GQG ou aux Halles.", "Your economy: it heads for the nearest coal or radium seam, fills its hopper and brings the lot back to the GHQ or the Market Halls."),
    tr("Le radium vaut 1,6× le charbon par chargement : les gisements de radium valent qu'on se batte pour eux.", "Radium is worth 1.6× coal per load: radium seams are worth fighting over."),
    tr("Lent et non armé ; les raids aériens le chassent en priorité. Bâtis des Halles près des gisements éloignés pour raccourcir le trajet.", "Slow and unarmed; air raids hunt it first. Build Market Halls near distant seams to shorten the trip."),
    tr("Ne laisse aucune épave à récupérer.", "Leaves no wreck to salvage.")
  ],
  scout: [
    tr("Le dirigeable le plus rapide de la carte, avec la plus grande vision.", "The fastest airship on the map, with the widest vision."),
    tr("Non armée : sers-t'en pour trouver la base ennemie, repérer les gisements et guetter les attaques dans le brouillard.", "Unarmed: use it to find the enemy base, spot the seams and watch for attacks in the fog."),
    tr("Bon marché et rapide à produire — en perdre une n'est pas grave si elle t'a rapporté du renseignement.", "Cheap and quick to produce — losing one doesn't matter if it brought back intelligence.")
  ],
  stinger: [
    tr("Automitrailleuse légère, rapide et bon marché, à canon en tourelle — la colonne vertébrale d'une armée en début de partie.", "Light armoured car, fast and cheap, with a turret gun — the backbone of an early-game army."),
    tr("Assez rapide pour raider les Fardiers et distancer les blindés plus lents.", "Fast enough to raid Steam Wagons and outrun slower armour."),
    tr("À coût égal, bat Faucheux, Canons de 75 et Hydroglisseurs, mais ne peut pas tirer sur les appareils.", "At equal cost, beats Daddy-Longlegs, French 75s and Hydrogliders, but can't fire at aircraft.")
  ],
  "flak-crawler": [
    tr("La réponse antiaérienne dédiée : des rafales de DCA rapides qui déchiquettent les aéronefs, très efficaces contre les appareils légers.", "The dedicated anti-air answer: rapid bursts of flak that shred aircraft, especially effective against light machines."),
    tr("À coût égal, bat tous les appareils, bombardiers Albatros compris.", "At equal cost, beats every aircraft, Albatros bombers included."),
    tr("Totalement impuissant face aux unités au sol — escorte-le avec des chars.", "Utterly helpless against ground units — escort it with tanks.")
  ],
  mortar: [
    tr("Artillerie longue portée : tire plus loin que toute Hotchkiss ou Batterie Ruggieri, l'outil idéal pour percer une base.", "Long-range artillery: fires further than any Hotchkiss or Ruggieri Battery, the ideal tool for cracking a base."),
    tr("Les obus sont de vrais projectiles à effet de zone, visant la position passée de la cible — les unités rapides peuvent les esquiver.", "Shells are real area-effect projectiles aimed at the target's past position — fast units can dodge them."),
    tr("Portée minimale et blindage léger : tout ce qui s'approche le met en pièces.", "Minimum range and light armour: anything that gets close tears it apart.")
  ],
  mastodon: [
    tr("Char super-lourd à double canon, sorti des aciéries du Creusot : de loin le char le plus résistant.", "Super-heavy twin-gun tank, out of the Creusot steelworks: by far the toughest tank."),
    tr("Ses canons frappent plus fort les blindés lourds, et il écrase Panhard, Faucheux et Canons de 75.", "Its guns hit heavy armour harder, and it crushes Panhards, Daddy-Longlegs and French 75s."),
    tr("Lent et incapable de tirer en l'air — Éole et Hydroglisseurs sont son cauchemar.", "Slow and unable to fire at air — Éoles and Hydrogliders are its nightmare.")
  ],
  lancer: [
    tr("Hydroglisseur : traverse l'eau et les hauts-fonds et ignore le terrain accidenté, ouvrant des routes interdites aux chenillés.", "Hydroglider: crosses water and shallows and ignores rough ground, opening routes closed to tracked vehicles."),
    tr("Son arc électrique perce les blindages lourds (1,55×) : c'est le tueur de Creusot.", "Its electric arc pierces heavy armour (1.55×): the Creusot killer."),
    tr("Le seul char qui peut aussi tirer sur les appareils, avec un effet réduit.", "The only tank that can also fire at aircraft, at reduced effect.")
  ],
  wasp: [
    tr("Aéronef d'attaque à roquettes qui survole tous les obstacles pour frapper les cibles au sol.", "Rocket attack aircraft that flies over every obstacle to hit ground targets."),
    tr("À coût égal, bat chars et artillerie — parfait pour harceler Fardiers et Canons de 75.", "At equal cost, beats tanks and artillery — perfect for harassing Steam Wagons and French 75s."),
    tr("Tombe vite face aux Faucheux, aux Blériot et aux Batteries Ruggieri.", "Falls fast to Daddy-Longlegs, Blériots and Ruggieri Batteries.")
  ],
  raptor: [
    tr("Intercepteur de supériorité aérienne : des fusées rapides qui chassent les autres appareils.", "Air-superiority interceptor: fast rockets that hunt other aircraft."),
    tr("Contre les Éole, Albatros et Pasteur.", "Counters Éoles, Albatros and Pasteurs."),
    tr("Ne peut rien attaquer au sol.", "Can't attack anything on the ground.")
  ],
  hornet: [
    tr("Bombardier lourd blindé qui pilonne unités au sol et bâtiments avec des dégâts de zone.", "Heavy armoured bomber that pounds ground units and buildings with area damage."),
    tr("Ses bombes explosives font 1,35× de dégâts aux structures — idéal pour raser une base.", "Its explosive bombs deal 1.35× damage to structures — ideal for razing a base."),
    tr("Les bombes sont des projectiles esquivables, et il lui faut une escorte contre Faucheux, Blériot et Ruggieri.", "The bombs are dodgeable projectiles, and it needs an escort against Daddy-Longlegs, Blériots and Ruggieri.")
  ],
  mender: [
    tr("Aéronef de réparation : un rayon qui soigne une unité ou un bâtiment allié endommagé à portée, un à la fois.", "Repair aircraft: a beam that heals one damaged friendly unit or building in range, one at a time."),
    tr("Garde une armée plus longtemps au combat ; l'IA s'en sert comme escorte.", "Keeps an army in the fight longer; the AI uses it as an escort."),
    tr("Non armé et peu blindé — Blériot et Faucheux l'abattent facilement.", "Unarmed and lightly armoured — Blériots and Daddy-Longlegs shoot it down easily.")
  ],
  trooper: [
    tr(`Cinq automates fusiliers qui combattent en une escouade : un seul total de PV, et un automate tombe à chaque cinquième perdu — la puissance de feu baisse avec eux.`, `Five automaton riflemen fighting as one squad: a single HP total, and one automaton falls for every fifth lost — firepower drops with them.`),
    tr("L'unité la moins chère capable de tirer sur les appareils, à moitié d'effet. Chaque camp commence avec une escouade.", "The cheapest unit able to fire at aircraft, at half effect. Each side starts with one squad."),
    tr(`Traverse bois et terrain accidenté à pleine vitesse, et ne subit que ${Math.round(INFANTRY.woodsCover * 100)} % des dégâts dans les bois (véhicules : ${Math.round(TERRAIN[Terrain.Forest].cover * 100)} %).`, `Crosses woods and rough ground at full speed, and takes only ${Math.round(INFANTRY.woodsCover * 100)}% of damage in woods (vehicles: ${Math.round(TERRAIN[Terrain.Forest].cover * 100)}%).`),
    tr(`Capture les Relais ${INFANTRY.captureWeight}× plus vite qu'un véhicule et ramasse les caisses de ravitaillement. Ne laisse pas d'épave.`, `Captures Relays ${INFANTRY.captureWeight}× faster than a vehicle and picks up supply crates. Leaves no wreck.`)
  ],
  "rocket-squad": [
    tr(`Trois automates à fusées d'épaule : dégâts de canon, ${DAMAGE_VS.cannon.heavy}× contre les blindés lourds — la réponse bon marché aux Creusot.`, `Three shoulder-rocket automata: cannon damage, ${DAMAGE_VS.cannon.heavy}× against heavy armour — the cheap answer to Creusots.`),
    tr(`Tire aussi sur les appareils (${UNITS["rocket-squad"].airMult}×) : Albatros et Éole paient cher leurs passages à basse altitude.`, `Also fires at aircraft (${UNITS["rocket-squad"].airMult}×): Albatros and Éoles pay dearly for low passes.`),
    tr("Faible contre l'infanterie : pioupious et chasseurs alpins la fauchent.", "Weak against infantry: poilus and alpine chasseurs mow them down.")
  ],
  sniper: [
    tr(`Deux tireurs d'élite au fusil Lebel : dégâts de précision, ${Math.round(shotDamage(UNITS.sniper))} par tir et ${DAMAGE_VS.precision.infantry}× contre l'infanterie — un tir abat environ trois automates pioupious.`, `Two marksmen with Lebel rifles: precision damage, ${Math.round(shotDamage(UNITS.sniper))} per shot and ${DAMAGE_VS.precision.infantry}× against infantry — one shot drops about three poilu automata.`),
    tr(`Caché dans les bois : l'ennemi ne le voit qu'à moins de ${INFANTRY.concealRadius} cases, sauf pendant ${INFANTRY.concealAfterShot} s après chaque tir.`, `Hidden in woods: the enemy only sees it within ${INFANTRY.concealRadius} tiles, except for ${INFANTRY.concealAfterShot} s after each shot.`),
    tr("Presque inutile contre blindés et bâtiments, et lent à tirer : tiens les véhicules à distance.", "Almost useless against armour and buildings, and slow to fire: keep vehicles at a distance.")
  ],
  condor: [
    tr(`Transport : emporte ${UNITS.condor.capacity} escouades d'infanterie au-dessus de l'eau, des rochers et de tout obstacle. Non armé.`, `Transport: carries ${UNITS.condor.capacity} infantry squads over water, rocks and any obstacle. Unarmed.`),
    tr(`Sélectionne des escouades et touche la Montgolfière pour les embarquer (1 s chacune, une fois arrivées) ; appui long sur la carte pour y voler et les larguer (elle fait du surplace ${INFANTRY.unloadHover} s), ou touche Débarquer.`, `Select squads and tap the Montgolfier Balloon to board them (1 s each, once they arrive); long-press the map to fly there and drop them (it hovers for ${INFANTRY.unloadHover} s), or tap Unload.`),
    tr(`Abattue au-dessus de la terre, ses escouades sautent avec au plus ${Math.round(INFANTRY.bailoutHp * 100)} % de PV ; au-dessus de l'eau ou des rochers, elles périssent avec elle.`, `Shot down over land, its squads jump out with at most ${Math.round(INFANTRY.bailoutHp * 100)}% HP; over water or rocks, they perish with it.`)
  ],
  goliath: [
    tr("Une machine géante qui marche, et une base mobile : mortiers d'épaule, arc électrique oculaire, canons de bras et mitrailleuses qui touchent aussi les appareils.", "A giant walking machine and a mobile base: shoulder mortars, an electric eye arc, arm cannons and machine guns that also hit aircraft."),
    tr(`Ancre-le (${GOLIATH.anchorTime} s pour s'ancrer, ${GOLIATH.packTime} s pour lever l'ancre) : il reçoit le charbon des Fardiers, forme de l'infanterie et te laisse bâtir des avant-postes à ${GOLIATH.buildRing} cases de lui, n'importe où sur la carte.`, `Anchor it (${GOLIATH.anchorTime} s to anchor, ${GOLIATH.packTime} s to weigh anchor): it takes coal from Steam Wagons, trains infantry and lets you build outposts ${GOLIATH.buildRing} tiles from it, anywhere on the map.`),
    tr(`Perd ses armes à mesure qu'il est touché : mortiers sous ${Math.round(GOLIATH.weapons.mortars.lostBelow * 100)} % de PV, arc électrique sous ${Math.round(GOLIATH.weapons.laser.lostBelow * 100)} %, canons sous ${Math.round(GOLIATH.weapons.cannons.lostBelow * 100)} %. Seuls les Pasteur le soignent, et chaque arme redémarre une fois réparée.`, `Loses its weapons as it's hit: mortars below ${Math.round(GOLIATH.weapons.mortars.lostBelow * 100)}% HP, electric arc below ${Math.round(GOLIATH.weapons.laser.lostBelow * 100)}%, cannons below ${Math.round(GOLIATH.weapons.cannons.lostBelow * 100)}%. Only Pasteurs heal it, and each weapon restarts once repaired.`),
    tr(`Toujours visible par l'ennemi. Deux Montgolfières vides peuvent le porter ; tant qu'un camp a un Gargantua, perdre son GQG ne fait pas perdre la partie. Chacun coûte ${Math.round(GOLIATH.costStep * 100)} % de plus par Gargantua déjà possédé.`, `Always visible to the enemy. Two empty Montgolfier Balloons can carry it; as long as a side has a Gargantua, losing its GHQ doesn't lose the match. Each costs ${Math.round(GOLIATH.costStep * 100)}% more per Gargantua already owned.`)
  ],
  // ---- the nations' units (PANACHE-CONCEPTION.md §1.5) ----
  fourgon: [
    tr(`Le récolteur électrique de la République : rapide (${UNITS.fourgon.speed} contre ${UNITS.harvester.speed} au Fardier), mais une petite cale de ${UNITS.fourgon.cargo ?? ECONOMY.harvesterCapacity} au lieu de ${ECONOMY.harvesterCapacity}.`, `The Republic's electric harvester: fast (${UNITS.fourgon.speed} against ${UNITS.harvester.speed} for the Steam Wagon), but a small hold of ${UNITS.fourgon.cargo ?? ECONOMY.harvesterCapacity} instead of ${ECONOMY.harvesterCapacity}.`),
    tr(`Le radium vaut ${fmt(NATIONS.republique.radiumValue)}× le charbon pour la République (${fmt(ECONOMY.crystalValue)}× en Classique) : pousse tes Fourgons vers les gisements du centre.`, `Radium is worth ${fmt(NATIONS.republique.radiumValue)}× coal to the Republic (${fmt(ECONOMY.crystalValue)}× in Classic): push your Vans towards the centre seams.`),
    tr("Non armé et fragile : garde-le sous la protection d'une Tour TSF ou d'une Bobine d'Arsonval.", "Unarmed and fragile: keep it under the protection of a Wireless Tower or a d'Arsonval Coil.")
  ],
  "jamais-contente": [
    tr("Le bolide électrique de début de partie, le blindé le plus rapide du jeu : idéal pour raider Fardiers et pièces d'artillerie.", "The early-game electric racer, the fastest armour in the game: ideal for raiding Steam Wagons and artillery pieces."),
    tr(`Son arc court perce le blindage (${DAMAGE_VS.laser.heavy}× contre les blindés lourds) : trois Jamais-Contente font fondre un Creusot.`, `Its short arc pierces armour (${DAMAGE_VS.laser.heavy}× against heavy armour): three Jamais-Contente melt a Creusot.`),
    tr(`Blindage léger et ${UNITS["jamais-contente"].hp} PV : les Panhard et les Fusiliers (arc ×${DAMAGE_VS.laser.infantry} contre l'infanterie) la battent. Ne tire pas en l'air.`, `Light armour and ${UNITS["jamais-contente"].hp} HP: Panhards and Fusiliers (arc ×${DAMAGE_VS.laser.infantry} against infantry) beat it. Can't fire at air.`)
  ],
  "de-dion": [
    tr("L'autocanon antiaérien de la République : un barrage rapide qui déchire Gyroptères, Vulcains et Titans.", "The Republic's anti-aircraft autocannon: a rapid barrage that tears through Gyropters, Vulcans and Titans."),
    tr(`Portée ${UNITS["de-dion"].range} : il tient les Gyroptères à distance avant qu'ils ne puissent répondre.`, `Range ${UNITS["de-dion"].range}: it keeps Gyropters at a distance before they can reply.`),
    tr("Totalement impuissant au sol : escorte-le de Jamais-Contente ou d'Hydroglisseurs.", "Utterly helpless on the ground: escort it with Jamais-Contente or Hydrogliders.")
  ],
  branly: [
    tr(`Canon électromagnétique : obus rapides (vitesse ${UNITS.branly.projectileSpeed}) à ${UNITS.branly.range} cases, plus difficiles à esquiver que ceux d'un Canon de 75.`, `Electromagnetic gun: fast shells (speed ${UNITS.branly.projectileSpeed}) at ${UNITS.branly.range} tiles, harder to dodge than a French 75's.`),
    tr(`Portée minimale ${UNITS.branly.minRange} et seulement ${UNITS.branly.hp} PV : tout ce qui l'approche le détruit.`, `Minimum range ${UNITS.branly.minRange} and only ${UNITS.branly.hp} HP: anything that gets close destroys it.`),
    tr("Perce les défenses impériales de loin ; mais le Mortier de 280 le surclasse en portée.", "Pierces Imperial defences from afar; but the 280 mm Mortar outranges it.")
  ],
  sapeurs: [
    tr(`Trois sapeurs-électriciens à lance à arc : ${DAMAGE_VS.laser.heavy}× contre les blindés lourds — la réponse de la République aux Creusot et au Gargantua.`, `Three electric sappers with arc lances: ${DAMAGE_VS.laser.heavy}× against heavy armour — the Republic's answer to Creusots and the Gargantua.`),
    tr("Ne tirent pas en l'air, et le Creusot les écrase s'ils le laissent approcher.", "They can't fire at air, and the Creusot crushes them if they let it close in."),
    tr(`Comme toute infanterie : à couvert dans les bois (${Math.round(INFANTRY.woodsCover * 100)} % des dégâts), et capturent les Relais ${INFANTRY.captureWeight}× plus vite.`, `Like all infantry: under cover in woods (${Math.round(INFANTRY.woodsCover * 100)}% damage), and they capture Relays ${INFANTRY.captureWeight}× faster.`)
  ],
  zenith: [
    tr("Croiseur aérien et base volante : seuls l'antiaérien et les armes qui touchent l'air peuvent l'atteindre.", "Air cruiser and flying base: only anti-air and weapons that hit air can reach it."),
    tr(`Amarre-le (${ZENITH.anchorTime} s ; ${ZENITH.packTime} s pour larguer les amarres) au-dessus d'un sol constructible : il reçoit le charbon, produit ${ZENITH.trains.map((k) => pluralName(k)).join(", ")}, alimente le réseau électrique et te laisse bâtir à ${ZENITH.buildRing} cases de lui.`, `Moor it (${ZENITH.anchorTime} s; ${ZENITH.packTime} s to cast off) above buildable ground: it takes coal, produces ${ZENITH.trains.map((k) => pluralName(k)).join(", ")}, feeds the power grid and lets you build ${ZENITH.buildRing} tiles from it.`),
    tr(`Perd ses armes à mesure qu'il est touché : ${(["branly", "arc", "bombs"] as const).map((k) => `${ZENITH.weapons[k].name} sous ${Math.round(ZENITH.weapons[k].lostBelow * 100)}${NB}%`).join(", ")}. Seuls les Pasteur le réparent.`, `Loses its weapons as it's hit: ${(["branly", "arc", "bombs"] as const).map((k) => `${ZENITH.weapons[k].name} below ${Math.round(ZENITH.weapons[k].lostBelow * 100)}${NB}%`).join(", ")}. Only Pasteurs repair it.`),
    tr(`Toujours visible par l'ennemi. Chacun coûte ${Math.round(ZENITH.costStep * 100)} % de plus par Zénith déjà possédé ; tant qu'il vole, perdre le GQG ne fait pas perdre la partie.`, `Always visible to the enemy. Each costs ${Math.round(ZENITH.costStep * 100)}% more per Zénith already owned; while it flies, losing the GHQ doesn't lose the match.`)
  ],
  estafette: [
    tr(`L'éclaireur de l'Empire : une motocyclette à vapeur à ${UNITS.estafette.speed} de vitesse et ${UNITS.estafette.sight} cases de vision.`, `The Empire's scout: a steam motorcycle with ${UNITS.estafette.speed} speed and ${UNITS.estafette.sight} tiles of vision.`),
    tr(`La moins chère des unités (${UNITS.estafette.cost}) : envoie-la trouver la base ennemie, puis guetter pour le Mortier de 280.`, `The cheapest unit (${UNITS.estafette.cost}): send it to find the enemy base, then to spot for the 280 mm Mortar.`),
    tr("Reste au sol : l'eau, les falaises et les rochers l'arrêtent. Non armée.", "Stays on the ground: water, cliffs and rocks stop it. Unarmed.")
  ],
  "mortier-280": [
    tr(`Pièce de siège : ${UNITS["mortier-280"].range} cases de portée, plus que toute défense (Bobine ${fmt(BUILDINGS.arsonval.range)}, Ruggieri ${fmt(BUILDINGS["sam-site"].range)}) — il démolit une base sans lui laisser riposter.`, `Siege piece: ${UNITS["mortier-280"].range} tiles of range, more than any defence (Coil ${fmt(BUILDINGS.arsonval.range)}, Ruggieri ${fmt(BUILDINGS["sam-site"].range)}) — it demolishes a base without letting it reply.`),
    tr(`Aveugle : il ne voit qu'à ${UNITS["mortier-280"].sight} cases. Il lui faut un guetteur (Estafette, Ballon captif) pour tirer au loin.`, `Blind: it only sees ${UNITS["mortier-280"].sight} tiles. It needs a spotter (Dispatch Rider, Tethered Balloon) to fire far.`),
    tr(`Portée minimale ${UNITS["mortier-280"].minRange}, lent et un obus toutes les ${UNITS["mortier-280"].shotInterval} s : les Jamais-Contente et les Éole le détruisent.`, `Minimum range ${UNITS["mortier-280"].minRange}, slow and one shell every ${UNITS["mortier-280"].shotInterval} s: Jamais-Contente and Éoles destroy it.`)
  ],
  gyroptere: [
    tr("Autogire d'attaque à vapeur : son canon antichar frappe chars et artillerie par-dessus tous les obstacles.", "Steam attack autogyro: its anti-tank gun hits tanks and artillery over all obstacles."),
    tr(`Blindage moyen et ${UNITS.gyroptere.hp} PV : plus robuste qu'un Éole, mais plus lent.`, `Medium armour and ${UNITS.gyroptere.hp} HP: sturdier than an Éole, but slower.`),
    tr("Craint la DCA : l'Autocanon De Dion et la Batterie Ruggieri l'abattent. Ne tire pas en l'air.", "Fears flak: the De Dion Autocannon and the Ruggieri Battery shoot it down. Can't fire at air.")
  ],
  epervier: [
    tr(`Chasseur à vapeur : ses canons (${DAMAGE_VS.cannon.heavy}× contre les blindages lourds) percent Albatros et Zénith.`, `Steam fighter: its guns (${DAMAGE_VS.cannon.heavy}× against heavy armour) pierce Albatros and Zénith.`),
    tr("Bat les Éole, mais le Blériot, plus rapide et à plus longue portée, garde un léger avantage sur lui.", "Beats Éoles, but the Blériot, faster and longer-ranged, keeps a slight edge over it."),
    tr("Ne tire pas au sol.", "Doesn't fire at the ground.")
  ],
  vulcain: [
    tr(`Bombardier blindé (${UNITS.vulcain.hp} PV, blindage lourd) : ses bombes de zone écrasent bases, défenses et colonnes.`, `Armoured bomber (${UNITS.vulcain.hp} HP, heavy armour): its area bombs crush bases, defences and columns.`),
    tr(`Lent (${UNITS.vulcain.speed}) et désarmé contre l'air : escorte-le d'Éperviers.`, `Slow (${UNITS.vulcain.speed}) and defenceless against air: escort it with Sparrowhawks.`),
    tr("Les Blériot, l'Autocanon De Dion et les Batteries Ruggieri sont ses ennemis.", "Blériots, the De Dion Autocannon and Ruggieri Batteries are its enemies.")
  ],
  atelier: [
    tr(`Locomobile de réparation : ${UNITS.atelier.heal} PV/s aux véhicules, au Gargantua et aux bâtiments à ${UNITS.atelier.range} cases.`, `Repair locomobile: ${UNITS.atelier.heal} HP/s to vehicles, the Gargantua and buildings within ${UNITS.atelier.range} tiles.`),
    tr("Ne répare pas les aéronefs : seuls les appareils de la République ont leur Pasteur.", "Doesn't repair aircraft: only the Republic's machines have their Pasteur."),
    tr(`Blindage moyen et ${UNITS.atelier.hp} PV : il suit la colonne au lieu de rester en arrière.`, `Medium armour and ${UNITS.atelier.hp} HP: it follows the column instead of staying behind.`)
  ],
  fusiliers: [
    tr(`Cinq automates fusiliers cuirassés (${UNITS.fusiliers.hp} PV) : l'infanterie de ligne de l'Empire. Tirent sol et air (${fmt(UNITS.fusiliers.airMult ?? 1)}× en l'air).`, `Five armoured automaton riflemen (${UNITS.fusiliers.hp} HP): the Empire's line infantry. Fire at ground and air (${fmt(UNITS.fusiliers.airMult ?? 1)}× against air).`),
    tr(`Se retranchent : immobiles ${NATIONS.empire.trench?.still ?? 3} s, ils ne subissent plus que ${Math.round((NATIONS.empire.trench?.mult ?? 1) * 100)} % des dégâts (à ${NATIONS.empire.trench?.redoubtRadius ?? 0} cases d'une Hotchkiss : aussitôt).`, `Dig in: standing still ${NATIONS.empire.trench?.still ?? 3} s, they take only ${Math.round((NATIONS.empire.trench?.mult ?? 1) * 100)}% damage (within ${NATIONS.empire.trench?.redoubtRadius ?? 0} tiles of a Hotchkiss: at once).`),
    tr("Battent les Jamais-Contente ; les chasseurs alpins, de plus loin, les déciment.", "Beat the Jamais-Contente; Alpine Chasseurs, from further away, decimate them.")
  ],
  carabiniers: [
    tr(`Deux carabiniers blindés : dégâts de précision, ${DAMAGE_VS.precision.infantry}× contre l'infanterie — ils effacent pioupious et sapeurs.`, `Two armoured carabiniers: precision damage, ${DAMAGE_VS.precision.infantry}× against infantry — they wipe out poilus and sappers.`),
    tr(`Portée ${UNITS.carabiniers.range}, plus courte que les chasseurs alpins (${UNITS.sniper.range}) : ceux-ci les battent.`, `Range ${UNITS.carabiniers.range}, shorter than the Alpine Chasseurs' (${UNITS.sniper.range}): those beat them.`),
    tr("Se retranchent comme toute escouade impériale ; presque inutiles contre les blindés.", "Dig in like every Imperial squad; almost useless against armour.")
  ],
  titan: [
    tr(`Dirigeable-cargo cuirassé : emporte ${UNITS.titan.capacity} escouades au-dessus de l'eau et des obstacles. Non armé.`, `Armoured cargo airship: carries ${UNITS.titan.capacity} squads over water and obstacles. Unarmed.`),
    tr(`Blindage lourd et ${UNITS.titan.hp} PV : il survit mieux qu'une Montgolfière à la DCA.`, `Heavy armour and ${UNITS.titan.hp} HP: it survives flak better than a Montgolfier Balloon.`),
    tr("Deux Titans vides soulèvent un Gargantua et le portent n'importe où sur la carte.", "Two empty Titans lift a Gargantua and carry it anywhere on the map.")
  ]
};

export const GROUPS: { title: string; kinds: UnitKind[] }[] = [
  { title: tr("Produit au GQG", "Produced at the GHQ"), kinds: ["harvester"] },
  { title: tr("Forges — véhicules terrestres", "Forges — ground vehicles"), kinds: ["stinger", "flak-crawler", "mortar", "mastodon", "lancer"] },
  { title: tr("Manufacture — infanterie automate", "Manufactory — automaton infantry"), kinds: ["trooper", "rocket-squad", "sniper"] },
  { title: tr("Parc de Chalais-Meudon — aéronefs", "Chalais-Meudon Airpark — aircraft"), kinds: ["scout", "wasp", "raptor", "hornet", "mender", "condor"] },
  { title: tr("Galerie des Machines — Gargantua", "Galerie des Machines — Gargantua"), kinds: ["goliath"] }
];

const TARGETS = tr({ ground: "Sol", air: "Air", both: "Sol + air", none: "Non armé" }, { ground: "Ground", air: "Air", both: "Ground + air", none: "Unarmed" });
const DMG: Record<string, string> = {
  ...tr(
    { kinetic: "cinétique", cannon: "canon", flak: "DCA", missile: "missile", explosive: "explosif", laser: "arc électrique", precision: "précision" },
    { kinetic: "kinetic", cannon: "cannon", flak: "flak", missile: "missile", explosive: "explosive", laser: "electric arc", precision: "precision" }
  )
};
const ARMOR: Record<string, string> = tr(
  { light: "léger", medium: "moyen", heavy: "lourd", structure: "structure", infantry: "infanterie" },
  { light: "light", medium: "medium", heavy: "heavy", structure: "structure", infantry: "infantry" }
);

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
    if (t && kind !== "zenith") out.push(tr(`<b>Réseau TSF</b> : à ${t.radius} cases d'une Tour TSF ou d'un Zénith, vitesse ×${fmt(t.speed)} et vision +${t.sight}.`, `<b>Wireless Net</b>: within ${t.radius} tiles of a Wireless Tower or a Zénith, speed ×${fmt(t.speed)} and vision +${t.sight}.`));
    out.push(tr(`<b>Préfabriqué</b> : produit en ${fmt(u.buildTime * NATIONS.republique.unitTime)}${NB}s au lieu de ${u.buildTime}${NB}s.`, `<b>Prefabricated</b>: built in ${fmt(u.buildTime * NATIONS.republique.unitTime)}${NB}s instead of ${u.buildTime}${NB}s.`));
  } else {
    const trench = NATIONS.empire.trench;
    if (u.squad && trench)
      out.push(
        tr(
          `<b>Tranchées</b> : retranchée après ${trench.still}${NB}s immobile, dégâts subis ×${fmt(trench.mult)} (à ${fmt(trench.redoubtRadius)} cases d'une Hotchkiss : aussitôt).`,
          `<b>Trenches</b>: dug in after ${trench.still}${NB}s standing still, damage taken ×${fmt(trench.mult)} (within ${fmt(trench.redoubtRadius)} tiles of a Hotchkiss: at once).`
        )
      );
    if (kind !== "goliath")
      out.push(tr(`<b>Vapeur</b> : ${fmt(u.buildTime * NATIONS.empire.unitTime)}${NB}s de production au lieu de ${u.buildTime}${NB}s, mais chaque usine en fabrique ${NATIONS.empire.parallel} à la fois.`, `<b>Steam</b>: ${fmt(u.buildTime * NATIONS.empire.unitTime)}${NB}s to build instead of ${u.buildTime}${NB}s, but each factory builds ${NATIONS.empire.parallel} at a time.`));
  }
  return out;
}

const stat = (value: string | number, label: string): string =>
  `<div class="stat"><b>${value}</b><span>${label}</span></div>`;


/** One of the Goliath's weapon systems: what it fires, how hard and how far, and when damage takes it offline. */
function goliathWeapon(w: GoliathWeaponStats): string {
  const bits = [
    `<b>${w.name}</b> ${DMG[w.dmgType!] ?? w.dmgType}`,
    tr(`${fmt(shotDamage(w))} toutes les ${w.shotInterval ?? 0.5}${NB}s`, `${fmt(shotDamage(w))} every ${w.shotInterval ?? 0.5}${NB}s`),
    tr(`portée ${w.range}${w.minRange ? ` (min ${w.minRange})` : ""}`, `range ${w.range}${w.minRange ? ` (min ${w.minRange})` : ""}`),
    TARGETS[w.targets].toLowerCase(),
    w.lostBelow > 0 ? tr(`hors service sous ${Math.round(w.lostBelow * 100)}${NB}% PV`, `out of action below ${Math.round(w.lostBelow * 100)}${NB}% HP`) : tr("jamais hors service", "never out of action")
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
  if (u.heal)
    return tr(
      `<b>${u.healTargets === "ground" ? "Atelier de réparation" : "Rayon de réparation"}</b> · ${u.heal} PV/s · portée ${u.range}${u.healTargets === "ground" ? " · sol et bâtiments seulement" : ""}`,
      `<b>${u.healTargets === "ground" ? "Repair workshop" : "Repair beam"}</b> · ${u.heal} HP/s · range ${u.range}${u.healTargets === "ground" ? " · ground and buildings only" : ""}`
    );
  return armedLine(u);
}

/** A unit's or building's weapon: its damage type, how hard and how often, and what it's strong against. */
function armedLine(u: ArmedStats): string {
  if (u.targets === "none") return tr("<b>Aucune arme</b>", "<b>No weapon</b>");
  const strong = (Object.entries(DAMAGE_VS[u.dmgType!]) as [ArmorClass, number][])
    .filter(([a, m]) => a !== "structure" ? m > 1 : m >= 1.3)
    .map(([a, m]) => `${a === "structure" ? tr("bâtiments", "buildings") : a === "infantry" ? tr("infanterie", "infantry") : tr(`blindage ${ARMOR[a]}`, `${ARMOR[a]} armour`)} ×${fmt(m)}`);
  const bits = [
    tr(`dégâts <b>${DMG[u.dmgType!] ?? u.dmgType}</b>`, `<b>${DMG[u.dmgType!] ?? u.dmgType}</b> damage`),
    tr(`${fmt(shotDamage(u))} par tir toutes les ${u.shotInterval ?? 0.5}${NB}s`, `${fmt(shotDamage(u))} per shot every ${u.shotInterval ?? 0.5}${NB}s`),
    u.minRange ? tr(`portée min ${u.minRange}`, `min range ${u.minRange}`) : "",
    u.splash ? tr(`zone ${u.splash} cases`, `area ${u.splash} tiles`) : "",
    u.airMult ? tr(`×${fmt(u.airMult)} contre l'air`, `×${fmt(u.airMult)} against air`) : "",
    strong.length ? tr(`fort contre ${strong.join(", ")}`, `strong against ${strong.join(", ")}`) : ""
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
    `<span class="tag">${u.hover ? tr("Hydroglisseur", "Hydroglider") : u.squad ? tr("Infanterie", "Infantry") : u.domain === "air" ? tr("Air", "Air") : tr("Sol", "Ground")}</span>`,
    `<span class="tag">${u.armor === "infantry" ? tr(`escouade de ${u.squad}`, `squad of ${u.squad}`) : tr(`blindage ${ARMOR[u.armor]}`, `${ARMOR[u.armor]} armour`)}</span>`,
    u.capacity ? `<span class="tag">${tr(`Emporte ${u.capacity} escouades`, `Carries ${u.capacity} squads`)}</span>` : "",
    `<span class="tag">${displayName(u.builtAt, n)}</span>`,
    u.requires ? `<span class="tag tech">${tr("⚗ Requiert", "⚗ Requires")} ${displayName(u.requires, n)}</span>` : ""
  ].join("");
  const matchups =
    beats.length || fears.length
      ? `<div class="matchups">
          <div class="beats"><h4>${tr("Fort contre", "Strong against")}</h4>${beats.map((k) => threatLink(k, n)).join(", ") || "—"}</div>
          <div class="fears"><h4>${tr("Faible contre", "Weak against")}</h4>${fears.map((k) => threatLink(k, n)).join(", ") || "—"}</div>
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
      ${stat(u.cost, tr("Charbon", "Coal"))}
      ${stat(u.hp, tr("PV", "HP"))}
      ${stat(u.speed, tr("Vitesse", "Speed"))}
      ${stat(u.sight, tr("Vision", "Vision"))}
      ${stat(u.dps || (u.heal ? `+${u.heal}` : "—"), u.heal ? tr("Soin/s", "Heal/s") : "DPS")}
      ${stat(u.range || "—", tr("Portée", "Range"))}
      ${stat(TARGETS[u.targets], tr("Cibles", "Targets"))}
      ${stat(`${fmt(time)}${NB}s`, tr("Prod.", "Build"))}
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
    ...by("hq", tr("récolteur", "harvester")),
    ...by("fab-plant", tr("véhicules terrestres", "ground vehicles")),
    ...by("assembly-bay", tr("infanterie automate", "automaton infantry")),
    ...by("airpad", tr("aéronefs", "aircraft")),
    ...by("gantry", tr("super-unité", "super-unit"))
  ];
}

// ------------------------------------------------------------ buildings ---

/** The map's objectives: no one builds them, both sides fight over them. */
export type ObjectiveKind = "uplink" | "supply-crate";
export type SiteKind = BuildingKind | ObjectiveKind;

export const BUILDING_GROUPS: { title: string; kinds: SiteKind[] }[] = [
  { title: tr("Commandement et économie", "Command and economy"), kinds: ["hq", "depot", "radar"] },
  { title: tr("Production", "Production"), kinds: ["fab-plant", "airpad", "assembly-bay", "tech-lab", "gantry"] },
  { title: tr("Défenses", "Defences"), kinds: ["turret", "sam-site"] },
  { title: tr("Objectifs de carte", "Map objectives"), kinds: ["uplink", "supply-crate"] }
];

const isObjective = (k: SiteKind): k is ObjectiveKind => k === "uplink" || k === "supply-crate";
const U = OBJECTIVES.uplink;
const D = OBJECTIVES.drops;
const mmss = (s: number): string => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
const OBJECTIVE_INFO: Record<ObjectiveKind, { name: string; role: string; tags: string[]; stats: [string | number, string][]; features: string[] }> = {
  uplink: {
    name: tr("Relais TSF", "Wireless Relay"),
    role: tr("Un relais capturable au cœur disputé de la carte : charbon, vision et charge de commandement pour qui le tient.", "A capturable relay at the contested heart of the map: coal, vision and command charge for whoever holds it."),
    tags: tr(["Neutre", "Capturable"], ["Neutral", "Capturable"]),
    stats: [[`${U.income}/s`, tr("Charbon", "Coal")], [U.sight, tr("Vision", "Vision")], [U.radius, tr("Zone", "Zone")], [`~${Math.round(100 / U.maxRate)}${NB}s`, tr("Capture", "Capture")]],
    features: [
      tr(`Gare des unités dans sa zone de ${U.radius} cases pour faire pencher la barre de capture : de neutre à toi, il faut environ ${Math.round(100 / U.maxRate)} s avec quatre unités, deux fois plus pour le reprendre à l'ennemi.`, `Park units in its ${U.radius}-tile zone to tip the capture bar: from neutral to yours takes about ${Math.round(100 / U.maxRate)} s with four units, twice as long to take it back from the enemy.`),
      tr(`Les escouades d'infanterie comptent ${INFANTRY.captureWeight}× et les appareils ${U.airWeight}× ; les Fardiers ne comptent pas.`, `Infantry squads count ${INFANTRY.captureWeight}× and aircraft ${U.airWeight}×; Steam Wagons don't count.`),
      tr(`Son détenteur gagne ${U.income} de charbon par seconde, voit à ${U.sight} cases autour et recharge sa jauge de commandement pour les frappes.`, `Its holder earns ${U.income} coal per second, sees ${U.sight} tiles around it and recharges their command gauge for strikes.`),
      tr("Certains sont sur des îles que seule l'infanterie amenée en Montgolfière peut prendre, et un relais insulaire ne rapporte que tant que des troupes l'occupent.", "Some sit on islands that only infantry brought by Montgolfier Balloon can take, and an island relay only pays while troops occupy it.")
    ]
  },
  "supply-crate": {
    name: tr("Caisse de ravitaillement", "Supply crate"),
    role: tr("Parachutées par paires sur le champ de bataille : la première unité sur place la prend.", "Parachuted in pairs onto the battlefield: the first unit on the spot takes it."),
    tags: tr(["Neutre", "Annoncée aux deux camps"], ["Neutral", "Announced to both sides"]),
    stats: [[mmss(D.first), tr("Première", "First")], [`${D.every}${NB}s`, tr("Toutes les", "Every")], [`${D.warning}${NB}s`, tr("Préavis", "Warning")], [`${D.ttl}${NB}s`, tr("Durée", "Lifetime")]],
    features: [
      tr(`Le premier largage arrive à ${mmss(D.first)}, puis un toutes les ${D.every} s, annoncé aux deux camps ${D.warning} s à l'avance par une colonne de lumière là où il tombera.`, `The first drop arrives at ${mmss(D.first)}, then one every ${D.every} s, announced to both sides ${D.warning} s ahead by a column of light where it will land.`),
      tr(`Toute unité sauf un Fardier qui s'approche à ${D.claimRadius} cases la récupère ; sinon, elle se consume après ${D.ttl} s.`, `Any unit except a Steam Wagon that comes within ${D.claimRadius} tiles collects it; otherwise it burns away after ${D.ttl} s.`),
      tr(`Contenu : ${D.scrap} de charbon, Vétérans (+1 rang à l'unité et aux alliés à ${D.veteranRadius} cases), Réparation de campagne (${Math.round(D.repairShare * 100)} % de PV à tes unités à ${D.repairRadius} cases), +${D.charge} de charge de commandement, ou, rarement, un Hydroglisseur offert.`, `Contents: ${D.scrap} coal, Veterans (+1 rank for the unit and allies within ${D.veteranRadius} tiles), Field repairs (${Math.round(D.repairShare * 100)}% HP for your units within ${D.repairRadius} tiles), +${D.charge} command charge, or, rarely, a free Hydroglider.`)
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
    tr("Chaque camp en a un au départ, et on ne peut pas en construire : le cœur de ta base.", "Each side has one at the start, and none can be built: the heart of your base."),
    tr(`Produit les Fardiers et reçoit leur charbon, et récupère seul ${ECONOMY.hqTrickle} de charbon par seconde : un camp ruiné n'est jamais bloqué.`, `Produces Steam Wagons and receives their coal, and regains ${ECONOMY.hqTrickle} coal per second by itself: a ruined side is never stuck.`),
    tr("Son canon de défense rapprochée chasse les premiers raids d'aéronefs. Il ne touche pas les unités au sol : laisse-les aux vraies défenses.", "Its close-defence gun chases off the first aircraft raids. It doesn't hit ground units: leave those to real defences."),
    tr("Perds-le avec tous tes Gargantuas, et la partie est perdue.", "Lose it along with all your Gargantuas, and the match is lost.")
  ],
  "fab-plant": [
    tr("Les forges des véhicules terrestres : chars, DCA, artillerie et hydroglisseurs sortent de leurs halls.", "The ground vehicle forges: tanks, flak, artillery and hydrogliders roll out of their halls."),
    tr(`Jusqu'à ${ECONOMY.maxQueue} en file d'attente ; touche la carte pour fixer le point de ralliement.`, `Up to ${ECONOMY.maxQueue} queued; tap the map to set the rally point.`),
    tr("Les modèles lourds exigent aussi Polytechnique.", "Heavy models also need Polytechnique.")
  ],
  airpad: [
    tr("Lance tous les aéronefs, de la Patrie à la Montgolfière de transport.", "Launches every aircraft, from the Patrie to the transport Montgolfier Balloon."),
    tr(`Jusqu'à ${ECONOMY.maxQueue} en file d'attente ; touche la carte pour fixer le point de ralliement.`, `Up to ${ECONOMY.maxQueue} queued; tap the map to set the rally point.`),
    tr("Les appareils ignorent le terrain : un Parc de Chalais-Meudon n'importe où peut frapper partout.", "Aircraft ignore terrain: a Chalais-Meudon Airpark anywhere can strike everywhere.")
  ],
  "assembly-bay": [
    tr("Assemble l'infanterie automate : Escouades de pioupious, Escouades d'artificiers et Sections de chasseurs alpins.", "Assembles automaton infantry: Poilu Squads, Rocketeer Squads and Alpine Chasseur Sections."),
    tr("Les escouades sont bon marché, se mettent à couvert dans les bois et capturent les Relais plus vite que tout.", "Squads are cheap, take cover in woods and capture Relays faster than anything."),
    tr("Un Gargantua ancré forme aussi de l'infanterie, où qu'il soit.", "An anchored Gargantua also trains infantry, wherever it is.")
  ],
  "tech-lab": [
    tr("Recherche, pas production : elle débloque les unités lourdes des autres bâtiments de production.", "Research, not production: it unlocks the heavy units of the other production buildings."),
    tr("Requiert d'abord des Forges, un Parc de Chalais-Meudon ou une Manufacture.", "First requires Forges, a Chalais-Meudon Airpark or a Manufactory."),
    tr("Perds-la et ces unités sont indisponibles jusqu'à sa reconstruction.", "Lose it and those units are unavailable until it's rebuilt.")
  ],
  gantry: [
    tr(`Construit le Gargantua, un à la fois en ${UNITS.goliath.buildTime} s : la machine s'élève par étapes sur son berceau, la grue posant les plaques de blindage.`, `Builds the Gargantua, one at a time in ${UNITS.goliath.buildTime} s: the machine rises in stages on its cradle, the crane laying the armour plates.`),
    tr("Requiert tous les autres bâtiments de production et Polytechnique. Une par camp.", "Requires all the other production buildings and Polytechnique. One per side."),
    tr("L'ennemi la voit toujours, ainsi que le Gargantua qui y prend forme : attends-toi à ce qu'il vienne le chercher.", "The enemy always sees it, and the Gargantua taking shape in it: expect them to come for it.")
  ],
  depot: [
    tr("Un point de dépôt avancé : les Fardiers déchargent au plus proche, donc des Halles près d'un gisement éloigné raccourcissent leur trajet.", "A forward drop-off point: Steam Wagons unload at the nearest, so Market Halls near a distant seam shorten their trip."),
    tr("Les Fardiers y déchargent comme au GQG ; elles ne produisent rien.", "Steam Wagons unload there as at the GHQ; they produce nothing."),
    tr("Bâties près d'un Gargantua ancré, des Halles d'avant-poste reçoivent le charbon n'importe où sur la carte.", "Built near an anchored Gargantua, outpost Market Halls receive coal anywhere on the map.")
  ],
  turret: [
    tr("Mitrailleuse de défense qui touche sol et air.", "Defensive machine gun that hits ground and air."),
    tr(`Les Canons de 75 portent plus loin (${UNITS.mortar.range} cases contre ${BUILDINGS.turret.range}) : perce-la à l'artillerie, pas aux chars.`, `French 75s reach further (${UNITS.mortar.range} tiles against ${BUILDINGS.turret.range}): break it with artillery, not tanks.`),
    tr(`Obus cinétiques : moins efficaces contre les blindés lourds (×${DAMAGE_VS.kinetic.heavy}), les Creusot s'en moquent.`, `Kinetic rounds: less effective against heavy armour (×${DAMAGE_VS.kinetic.heavy}), Creusots laugh them off.`)
  ],
  "sam-site": [
    tr(`Fusées antiaériennes longue portée, jusqu'à ${BUILDINGS["sam-site"].range} cases : plus loin que l'arme de n'importe quel appareil.`, `Long-range anti-aircraft rockets, up to ${BUILDINGS["sam-site"].range} tiles: further than any aircraft's weapon.`),
    tr("Ne peut rien viser au sol : chars et artillerie passent sous son nez.", "Can't target the ground: tanks and artillery pass right under its nose."),
    tr("Associe-la à une Hotchkiss pour couvrir les deux.", "Pair it with a Hotchkiss to cover both.")
  ],
  radar: [
    tr(`Voit à ${BUILDINGS.radar.sight} cases dans toutes les directions, la plus large vision du jeu, grâce à la télégraphie sans fil.`, `Sees ${BUILDINGS.radar.sight} tiles in every direction, the widest vision in the game, thanks to wireless telegraphy.`),
    tr("Guette les attaques à travers le brouillard, ou repère le prochain gisement.", "Watches for attacks through the fog, or spots the next seam."),
    tr("Non armée et fragile : facile à perdre lors d'un raid.", "Unarmed and fragile: easy to lose in a raid.")
  ],
  arsonval: [
    tr(`La défense au sol de la République : un arc électrique qui perce les blindés (${DAMAGE_VS.laser.heavy}× contre les blindages lourds) — Creusot et Panhard y fondent.`, `The Republic's ground defence: an electric arc that pierces armour (${DAMAGE_VS.laser.heavy}× against heavy armour) — Creusots and Panhards melt in it.`),
    tr("Ne tire pas en l'air : associe-la à une Batterie Ruggieri. La République n'a pas de Hotchkiss.", "Doesn't fire at air: pair it with a Ruggieri Battery. The Republic has no Hotchkiss."),
    tr(`Portée ${BUILDINGS.arsonval.range} : le Mortier de 280 (${UNITS["mortier-280"].range}) et le Canon de 75 (${UNITS.mortar.range}) la démolissent de loin.`, `Range ${BUILDINGS.arsonval.range}: the 280 mm Mortar (${UNITS["mortier-280"].range}) and the French 75 (${UNITS.mortar.range}) demolish it from afar.`)
  ],
  "flak-battery": [
    tr(`Canons antiaériens à vapeur : barrage de DCA jusqu'à ${BUILDINGS["flak-battery"].range} cases contre tout aéronef, Zénith compris.`, `Steam anti-aircraft guns: a barrage of flak up to ${BUILDINGS["flak-battery"].range} tiles against any aircraft, Zénith included.`),
    tr("Ne vise rien au sol : la Hotchkiss couvre le terrain.", "Doesn't target the ground: the Hotchkiss covers the terrain."),
    tr("Le Canon Branly la perce à distance ; sa robustesse impériale la rend longue à abattre.", "The Branly Gun pierces it from a distance; its Imperial sturdiness makes it slow to bring down.")
  ]
};

/** How a nation's buildings differ from Classique's (§1.2, §1.6): their notes, replacing Classique's where named. */
const NATION_BUILDING_FEATURES: Record<Nation, Partial<Record<BuildingKind, string[]>>> = {
  republique: {
    "sam-site": [
      tr(`Fusées antiaériennes longue portée, jusqu'à ${fmt(BUILDINGS["sam-site"].range)} cases : plus loin que l'arme de n'importe quel appareil.`, `Long-range anti-aircraft rockets, up to ${fmt(BUILDINGS["sam-site"].range)} tiles: further than any aircraft's weapon.`),
      tr("Ne peut rien viser au sol : associe-la à une Bobine d'Arsonval pour couvrir les deux.", "Can't target the ground: pair it with a d'Arsonval Coil to cover both.")
    ],
    "fab-plant": [
      tr("Le garage des véhicules électriques : Jamais-Contente, Autocanons De Dion, Canons Branly et Hydroglisseurs.", "The electric vehicle garage: Jamais-Contente, De Dion Autocannons, Branly Guns and Hydrogliders."),
      tr(`Jusqu'à ${ECONOMY.maxQueue} en file d'attente ; touche la carte pour fixer le point de ralliement.`, `Up to ${ECONOMY.maxQueue} queued; tap the map to set the rally point.`)
    ],
    hq: [
      tr("Le cœur de ta base, et la première source du réseau électrique : il alimente les bâtiments dont l'emprise est à ", "The heart of your base, and the first source of the power grid: it powers buildings whose footprint is within ") +
        tr(`${NATIONS.republique.power?.hqRadius ?? 0} cases de son centre.`, `${NATIONS.republique.power?.hqRadius ?? 0} tiles of its centre.`),
      tr(`Produit les Fourgons Jeantaud et reçoit leur charbon ; récupère seul ${ECONOMY.hqTrickle} de charbon par seconde.`, `Produces Jeantaud Vans and receives their coal; regains ${ECONOMY.hqTrickle} coal per second by itself.`),
      tr("Son canon de défense rapprochée chasse les premiers raids d'aéronefs. Perds-le avec tous tes Zéniths, et la partie est perdue.", "Its close-defence gun chases off the first aircraft raids. Lose it along with all your Zéniths, and the match is lost.")
    ],
    radar: [
      tr(`Le pylône du réseau : alimente les bâtiments à ${NATIONS.republique.power?.towerRadius ?? 0} cases, et toute unité de la République à ${NATIONS.republique.tsf?.radius ?? 0} cases gagne vitesse ×${fmt(NATIONS.republique.tsf?.speed ?? 1)} et vision +${NATIONS.republique.tsf?.sight ?? 0}.`, `The grid's pylon: powers buildings within ${NATIONS.republique.power?.towerRadius ?? 0} tiles, and every Republic unit within ${NATIONS.republique.tsf?.radius ?? 0} tiles gains speed ×${fmt(NATIONS.republique.tsf?.speed ?? 1)} and vision +${NATIONS.republique.tsf?.sight ?? 0}.`),
      tr(`Ne coûte que ${Math.round((NATIONS.republique.towerCost ?? BUILDINGS.radar.cost) * NATIONS.republique.buildingCost)} et suit la règle classique des 6 cases : bâtis-en pour étendre ta base.`, `Costs only ${Math.round((NATIONS.republique.towerCost ?? BUILDINGS.radar.cost) * NATIONS.republique.buildingCost)} and follows the classic 6-tile rule: build them to extend your base.`),
      tr("Fragile : chasser les Tours TSF, c'est éteindre la République. Protège-les.", "Fragile: hunting down the Wireless Towers means switching off the Republic. Protect them.")
    ],
    gantry: [
      tr(`Construit le Zénith, un à la fois en ${fmt(UNITS.zenith.buildTime * NATIONS.republique.unitTime)} s.`, `Builds the Zénith, one at a time in ${fmt(UNITS.zenith.buildTime * NATIONS.republique.unitTime)} s.`),
      tr("Requiert tous les autres bâtiments de production et Polytechnique. Un par camp.", "Requires all the other production buildings and Polytechnique. One per side."),
      tr("L'ennemi le voit toujours, ainsi que le Zénith qui y prend forme.", "The enemy always sees it, and the Zénith taking shape in it.")
    ],
    depot: [
      tr("Un point de dépôt avancé : les Fourgons déchargent au plus proche, donc une Station de charge près d'un gisement éloigné raccourcit leur trajet.", "A forward drop-off point: Vans unload at the nearest, so a Charging Station near a distant seam shortens their trip."),
      tr("Doit être alimentée comme tout bâtiment : bâtis d'abord une Tour TSF à côté des gisements éloignés.", "Must be powered like any building: build a Wireless Tower next to the distant seams first.")
    ]
  },
  empire: {
    airpad: [
      tr("Lance les aéronefs à vapeur : Gyroptères, Éperviers, Vulcains et Titans.", "Launches the steam aircraft: Gyropters, Sparrowhawks, Vulcans and Titans."),
      tr(`Jusqu'à ${ECONOMY.maxQueue} en file d'attente ; touche la carte pour fixer le point de ralliement.`, `Up to ${ECONOMY.maxQueue} queued; tap the map to set the rally point.`),
      tr("Les appareils ignorent le terrain : un Aérodrome n'importe où peut frapper partout.", "Aircraft ignore terrain: an Aerodrome anywhere can strike everywhere.")
    ],
    "assembly-bay": [
      tr("Assemble l'infanterie automate impériale : Fusiliers, Artificiers et Carabiniers.", "Assembles the Imperial automaton infantry: Fusiliers, Rocketeers and Carabiniers."),
      tr("Les escouades impériales se retranchent : postées, elles tiennent le terrain mieux que tout.", "Imperial squads dig in: posted, they hold ground better than anything.")
    ],
    hq: [
      tr("Le cœur de ta base : produit les Fardiers et reçoit leur charbon, et récupère seul ", "The heart of your base: produces Steam Wagons and receives their coal, and regains ") + tr(`${ECONOMY.hqTrickle} de charbon par seconde.`, `${ECONOMY.hqTrickle} coal per second by itself.`),
      tr("Sa DCA est celle du GQG : elle chasse les premiers raids d'aéronefs.", "Its flak is the GHQ's: it chases off the first aircraft raids."),
      tr("Perds-la avec tous tes Gargantuas, et la partie est perdue.", "Lose it along with all your Gargantuas, and the match is lost.")
    ],
    radar: [
      tr(`Un observatoire captif : voit à ${BUILDINGS.radar.sight} cases à travers le brouillard, et rien d'autre.`, `A tethered observatory: sees ${BUILDINGS.radar.sight} tiles through the fog, and nothing else.`),
      tr("Le guetteur idéal du Mortier de 280 : bâtis-le face à la base ennemie.", "The 280 mm Mortar's ideal spotter: build it facing the enemy base."),
      tr("Non armé et fragile.", "Unarmed and fragile.")
    ],
    turret: [
      tr("Mitrailleuse de défense qui touche sol et air.", "Defensive machine gun that hits ground and air."),
      tr(`Les escouades impériales à ${NATIONS.empire.trench?.redoubtRadius ?? 0} cases d'elle sont aussitôt retranchées (dégâts ×${fmt(NATIONS.empire.trench?.mult ?? 1)}).`, `Imperial squads within ${NATIONS.empire.trench?.redoubtRadius ?? 0} tiles of it dig in at once (damage ×${fmt(NATIONS.empire.trench?.mult ?? 1)}).`),
      tr(`Obus cinétiques : moins efficaces contre les blindés lourds (×${DAMAGE_VS.kinetic.heavy}).`, `Kinetic rounds: less effective against heavy armour (×${DAMAGE_VS.kinetic.heavy}).`)
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
      out.push(
        tr(
          `<b>Hors réseau : à l'arrêt.</b> Ne se pose qu'à ${s.power?.hqRadius ?? 0} cases du GQG ou ${s.power?.towerRadius ?? 0} d'une Tour TSF ; si sa source tombe, il cesse de produire et de tirer.`,
          `<b>Off the grid: shut down.</b> Can only be placed within ${s.power?.hqRadius ?? 0} tiles of the GHQ or ${s.power?.towerRadius ?? 0} of a Wireless Tower; if its source falls, it stops producing and firing.`
        )
      );
    out.push(tr(`<b>Préfabriqué</b> : coût ×${fmt(s.buildingCost)}, construction ×${fmt(s.buildingTime)}, PV ×${fmt(s.buildingHp)}.`, `<b>Prefabricated</b>: cost ×${fmt(s.buildingCost)}, build time ×${fmt(s.buildingTime)}, HP ×${fmt(s.buildingHp)}.`));
  } else {
    out.push(tr(`<b>Vapeur</b> : coût ×${fmt(s.buildingCost)}, construction ×${fmt(s.buildingTime)}, PV ×${fmt(s.buildingHp)}.`, `<b>Steam</b>: cost ×${fmt(s.buildingCost)}, build time ×${fmt(s.buildingTime)}, HP ×${fmt(s.buildingHp)}.`));
    if (kind === "fab-plant" || kind === "airpad" || kind === "assembly-bay")
      out.push(tr(`Fabrique ${s.parallel} unités de sa file à la fois, chacune ${fmt(s.unitTime)}× plus lentement.`, `Builds ${s.parallel} units from its queue at a time, each ${fmt(s.unitTime)}× slower.`));
  }
  return out;
}

/** A nation's buildings (or Classique's) in groups, as the models page lists them. */
export function buildingGroups(n: NationOrClassic): { title: string; kinds: SiteKind[] }[] {
  if (n === "classique") return BUILDING_GROUPS;
  const has = new Set(ROSTERS[n].buildings);
  const pick = (ks: BuildingKind[]) => ks.filter((k) => has.has(k));
  return [
    { title: tr("Commandement et économie", "Command and economy"), kinds: pick(["hq", "depot", "radar"]) },
    { title: tr("Production", "Production"), kinds: pick(["fab-plant", "airpad", "assembly-bay", "tech-lab", "gantry"]) },
    { title: tr("Défenses", "Defences"), kinds: pick(["arsonval", "turret", "sam-site", "flak-battery"]) }
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
    b.dropOff ? `<span class="tag">${tr("Dépôt de charbon", "Coal drop-off")}</span>` : "",
    b.unique ? `<span class="tag">${tr("Unique par camp", "One per side")}</span>` : "",
    b.alwaysVisible ? `<span class="tag">${tr("Toujours visible", "Always visible")}</span>` : "",
    b.requires ? `<span class="tag tech">${tr("Requiert", "Requires")} ${b.requires.map((k) => displayName(k, n)).join(tr(" ou ", " or "))}</span>` : "",
    b.requiresAll ? `<span class="tag tech">${tr("Requiert", "Requires")} ${b.requiresAll.map((k) => displayName(k, n)).join(", ")}</span>` : ""
  ].join("");
  const armed = b.targets !== "none";
  const beats = beatsOf(kind, n);
  const lists = [
    builds.length ? `<div class="beats"><h4>${tr("Produit", "Builds")}</h4>${builds.map(Un).join(", ")}</div>` : "",
    unlocks.length ? `<div class="beats"><h4>${tr("Débloque", "Unlocks")}</h4>${unlocks.map(Un).join(", ")}</div>` : "",
    n !== "classique" && beats.length ? `<div class="beats"><h4>${tr("Fort contre", "Strong against")}</h4>${beats.map((k) => threatLink(k, n)).join(", ")}</div>` : "",
    b.requires || b.requiresAll
      ? `<div class="fears"><h4>${tr("Requiert", "Requires")}</h4>${b.requires ? b.requires.map(B).join(tr(" ou ", " or ")) : b.requiresAll!.map(B).join(", ")}</div>`
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
      ${stat(cost || "—", tr("Charbon", "Coal"))}
      ${stat(hp, tr("PV", "HP"))}
      ${stat(b.sight, tr("Vision", "Vision"))}
      ${stat(time ? `${fmt(time)}${NB}s` : "—", tr("Prod.", "Build"))}
      ${armed ? stat(b.dps, "DPS") : ""}
      ${armed ? stat(b.range, tr("Portée", "Range")) : ""}
      ${armed ? stat(TARGETS[b.targets], tr("Cibles", "Targets")) : ""}
    </div>
    ${armed ? `<div class="weapon">${armedLine(b)}</div>` : ""}
    <ul class="features">${notes.map((f) => `<li>${f}</li>`).join("")}</ul>
    ${lists.length ? `<div class="matchups">${lists.join("")}</div>` : ""}
  </article>`;
}
