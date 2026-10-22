# Panache — Document de conception : nations asymétriques et « La Campagne de 1900 »

> Statut : conception, aucune ligne de code. Destiné directement aux agents d'implémentation.
> Branche : `fr-belle-epoque`. Références : `src/sim/balance.ts`, `types.ts`, `rules.ts`, `powers.ts`,
> `goliath.ts`, `ai/commander.ts`, `ops.ts`, `maps.ts`, `lexicon.ts`, `DESIGN.md`, `GOLIATH.md`, `INFANTRY.md`,
> `tools/balance.ts`, `tools/pacing.ts`, `tools/arena.ts`, `src/arena/record.ts`, `src/versus/*`.

## 0. Vocabulaire et principes non négociables

| Terme | Sens | Dans le code |
|---|---|---|
| **Camp** | la place à la table : bleu ou rouge (position de départ, ordre des ids) | `Faction = "blue" \| "red"` (existant, **inchangé**) |
| **Nation** | la « race » jouée : République ou Empire | **nouveau** `Nation = "republique" \| "empire"` |
| **Classique** | pas de nation : les 16 unités et 10 bâtiments actuels, symétriques | `nations` absent |

Attention : `Faction` désigne déjà le camp. Ne **jamais** renommer `Faction` ; la nation est une donnée de plus.

Principes :
1. **Classique = bit pour bit l'actuel.** Une partie sans `nations` doit produire exactement les mêmes hachages
   (`checksum.ts`) qu'aujourd'hui : replays de `battles/`, `tests/regressions.test.ts`, `symmetry.test.ts`,
   `ops.test.ts`, arène, duels sonores en `LOBBY_PROTO = 1`. Tout nouveau champ d'état n'entre dans le
   hachage que s'il est défini.
2. **Déterminisme.** Aucune `Math.random` dans la sim ; tout aléa vient de `rand.ts` (`worldRandom`).
   Les nouveaux effets (fumée, surpression, réseau) sont des fonctions pures du `World`.
3. **Réutiliser avant d'inventer.** Chaque nouvelle unité pointe vers un **comportement de base** existant
   (`base: UnitKind`) : récolteur, transport, réparateur, tireur d'élite, Gargantua… Seuls les mécanismes
   listés en §1.9 sont du code réellement nouveau.
4. **Ton.** Feuilleton muet à la Jules Verne, joueur, sans politique réelle ni atrocité réelle. Nations fictives :
   « la République » (Paris) et « l'Empire de Carbonie ». Aucun nom de pays réel, aucune représentation
   coloniale.

---

## 1. Les nations asymétriques

Inspirations : StarCraft II (races aux effectifs entièrement distincts et à l'économie propre), Age of Empires
(bonus de civilisation), Company of Heroes (doctrines → ici, pouvoirs), Warcraft III (héros → personnages de
campagne, §2.2), Northgard (identité par l'économie).

**Règle d'or : aucune unité commune.** Les 16 unités existantes sont réparties entre les deux nations
(9 pour la République, 7 pour l'Empire) ; 15 unités nouvelles comblent les rôles manquants. Chaque nation
couvre les 15 rôles du jeu.

### 1.1 Identités

| | **LA RÉPUBLIQUE** (bleu marine) | **L'EMPIRE DE CARBONIE** (bordeaux) |
|---|---|---|
| En une ligne | Ingénieurs, aviateurs et savants : rapide, aérien, nombreux, électrique, fragile. | Charbon, vapeur et acier : lent, blindé, l'artillerie la plus longue, des positions qu'on ne déloge pas. |
| Couleur d'équipe (`TEAMS`) | main `0x1f3f8a`, dark `0x12264f`, light `0x6f8fd0` | main `0x7a1f2b`, dark `0x431018`, light `0xc0606a` |
| Blason | Coq et éclair dans une couronne de laurier, sur fond marine | Locomotive vue de face sous une couronne crénelée, sur fond bordeaux |
| Économie | **Radium et électricité** : Fourgons rapides à petite cale, radium payé 50 % plus cher | **Charbon** : Fardiers lents à grosse cale, charbon extrait 15 % plus vite |
| Production | **Préfabriqué** : bâtiments moins chers et plus rapides mais fragiles, unités vite produites | **Vapeur** : bâtiments robustes et lents ; chaque usine fabrique **deux unités à la fois**, plus lentement |
| Construction | **Réseau électrique** (à la Protoss) : les bâtiments doivent être alimentés par le GQG ou une Tour TSF | Classique : à 6 cases de n'importe quel bâtiment, mais **Tranchées** pour l'infanterie |
| Super-unité | **Zénith**, croiseur aérien qui s'amarre et sert de base volante | **Gargantua**, machine qui marche (existant) |
| Pouvoirs | Ballon-sonde, Fée Électricité, Obus-capsule, Rayon Curie | Feu roulant, Gaz de houille, Pression des chaudières, Obus Méliès |

Couleurs : rendu seulement. Quand les nations diffèrent, la couleur suit la nation ; dans un **miroir**
(Rép-Rép, Emp-Emp) le camp rouge prend une variante (Rép : bleu horizon `0x5b8fc8` ; Emp : ocre-rouge
`0xa8502a`). Le Classique garde les couleurs actuelles bleu/rouge.

### 1.2 Mécaniques de nation (chiffres)

Toutes ces valeurs vivent dans une nouvelle table `NATIONS` de `balance.ts` (donc ajustables par `--tune`,
p. ex. `"NATIONS.republique.radiumValue":2.2`).

```ts
export const NATIONS = {
  republique: {
    // économie
    radiumValue: 2.4,          // classique ECONOMY.crystalValue = 1.6 (×1,5)
    coalRate: 1.0,             // × ECONOMY.harvestRate sur le charbon
    // Préfabriqué
    buildingCost: 0.85, buildingTime: 0.75, buildingHp: 0.8,
    unitTime: 0.85,            // × buildTime de toutes ses unités
    parallel: 1,               // unités fabriquées en même temps par usine
    // Réseau électrique
    power: { hqRadius: 8, towerRadius: 7 },   // cases, centre de la source → bord de l'emprise
    tsf: { radius: 9, speed: 1.12, sight: 2 }, // bonus des unités près d'une Tour TSF ou d'un Zénith
    towerCost: 150,            // Tour TSF (classique 200, avant le ×0,85)
  },
  empire: {
    radiumValue: 1.6,
    coalRate: 1.15,
    buildingCost: 1.1, buildingTime: 1.15, buildingHp: 1.25,
    unitTime: 1.3,
    parallel: 2,
    trench: { still: 3, mult: 0.7, redoubtRadius: 2.5 }, // Tranchées
  }
} as const;
```

(Après WP4 : `republique.radiumValue` 2,0 et `empire.trench.mult` 0,9 ; Branly 200 PV, De Dion 260 PV — §3.10.)

**République — Réseau électrique** (nouveau code, moyen)
- Placement : un bâtiment républicain (sauf GQG et Tour TSF) ne peut être posé que si son emprise est à
  `hqRadius` du centre d'un GQG ou à `towerRadius` d'une Tour TSF (remplace la règle des 6 cases ; la Tour TSF
  elle-même suit la règle classique des 6 cases).
- Alimentation : vérifiée une fois par seconde (`w.tick % TICK_RATE === 0`). Un bâtiment non alimenté (tour
  détruite) **suspend sa production et ses tirs** (même drapeau que l'étourdissement de la Fée Électricité,
  `isStunned`, mais via un ensemble `unpowered` distinct). Icône éclair barré au-dessus.
- **Réseau TSF** : toute unité républicaine à `tsf.radius` d'une Tour TSF ou d'un Zénith gagne vitesse ×1,12
  et vision +2. Calcul : liste des sources par camp recalculée chaque seconde ; lecture dans `movement.ts`
  (vitesse) et `fog.ts` (vision). Contre : chasser les Tours TSF (450 PV × 0,8 = 360).

**République — Préfabriqué** : coûts de bâtiment ×0,85, temps ×0,75, PV ×0,8 ; temps des unités ×0,85.
Appliqué en trois points seulement : `buildingBlocker`/`startBuilding` (coût), `PendingBuilding.remaining`
(temps), `spawnBuilding` (PV max via une fonction `buildingMaxHp(w, b)`), et `QueueItem.remaining` à la mise
en file (temps unité). Réutilise l'existant `unitCost(w, f, kind)` de `goliath.ts` comme modèle.

**Empire — Vapeur** : usines (Forges, Aérodrome, Caserne-atelier) fabriquant **2 éléments de file à la fois**
(les deux premiers de la file avancent ensemble), temps des unités ×1,3 → débit par usine ×1,54, mais il
faut le charbon pour l'alimenter. Bâtiments ×1,1 coût, ×1,15 temps, ×1,25 PV. Nouveau code : boucle de
production (`economy.ts`), ~30 lignes.

**Empire — Tranchées** (nouveau code, petit) : une escouade impériale sans ordre de mouvement et immobile
depuis `trench.still` = 3 s est **retranchée** : dégâts subis ×0,7. Dans les Bois on garde le meilleur des deux
(`min(0.5, 0.7)` = 0,5, pas de cumul). À ≤ 2,5 cases d'une Hotchkiss impériale : retranchée immédiatement.
Champ `Unit.still?: number` (tick depuis lequel elle ne bouge plus) — absent en Classique, donc hors hachage.
Rendu : un anneau de sacs de sable sous l'escouade.

**Économie** : chaque nation démarre avec 600 de charbon, son récolteur et son escouade de ligne
(Rép : Fourgon Jeantaud + Escouade de pioupious ; Emp : Fardier + Escouade de fusiliers). Le radium est rare
sur toutes les cartes (petits gisements, souvent au centre) : le bonus républicain pousse la République à
**contester le centre** tôt, l'Empire à tenir ses champs de charbon. À mesurer carte par carte (§1.8).

### 1.3 Répartition des 16 unités existantes

| Unité existante (kind) | Nation | Rôle chez elle |
|---|---|---|
| Patrie (`scout`) | République | éclaireur |
| Hydroglisseur (`lancer`) | République | blindé principal (glisseur, perce-blindage, tire en l'air) |
| Éole (`wasp`) | République | attaque aérienne |
| Blériot (`raptor`) | République | intercepteur |
| Albatros (`hornet`) | République | bombardier |
| Pasteur (`mender`) | République | réparateur aérien |
| Escouade de pioupious (`trooper`) | République | infanterie de ligne |
| Section de chasseurs alpins (`sniper`) | République | tireurs d'élite |
| Montgolfière (`condor`) | République | transport aérien |
| Fardier (`harvester`) | Empire | récolteur |
| Panhard (`stinger`) | Empire | blindé léger de début |
| Faucheux (`flak-crawler`) | Empire | antiaérien |
| Canon de 75 (`mortar`) | Empire | artillerie |
| Creusot (`mastodon`) | Empire | char lourd |
| Escouade d'artificiers (`rocket-squad`) | Empire | infanterie antichar (et antiaérienne) |
| Gargantua (`goliath`) | Empire | super-unité |

Les statistiques de ces 16 unités **ne changent pas** (le Classique les partage). L'asymétrie vient des
nouvelles unités, des mécaniques de nation et des multiplicateurs ci-dessus.

### 1.4 Effectifs complets par rôle

| Rôle | République | Empire |
|---|---|---|
| Récolteur | **Fourgon Jeantaud** ★ | Fardier |
| Éclaireur | Patrie | **Estafette** ★ |
| Blindé léger de début | **Jamais-Contente** ★ | Panhard |
| Antiaérien | **Autocanon De Dion** ★ | Faucheux |
| Artillerie | **Canon Branly** ★ | Canon de 75 |
| Siège | (Albatros, Zénith) | **Mortier de 280** ★ |
| Blindé lourd | Hydroglisseur | Creusot |
| Attaque aérienne | Éole | **Gyroptère** ★ |
| Intercepteur | Blériot | **Épervier** ★ |
| Bombardier | Albatros | **Vulcain** ★ |
| Réparateur | Pasteur (aérien) | **Atelier roulant** ★ (terrestre) |
| Infanterie de ligne | Escouade de pioupious | **Escouade de fusiliers** ★ |
| Infanterie antichar | **Escouade de sapeurs-électriciens** ★ | Escouade d'artificiers |
| Tireurs d'élite | Section de chasseurs alpins | **Section de carabiniers** ★ |
| Transport | Montgolfière | **Titan** ★ |
| Super-unité | **Zénith** ★ | Gargantua |
| **Total** | **15 unités** (6 nouvelles) | **16 unités** (9 nouvelles) |

★ = nouvelle unité (15 au total).

### 1.5 Les 15 nouvelles unités

Format : exactement celui de `UNITS` dans `balance.ts`, plus trois champs nouveaux :
- `nation: Nation` — à qui elle appartient (bannie en Classique et pour l'autre nation) ;
- `base?: UnitKind` — le comportement réutilisé (toutes les vérifications `u.kind === "harvester"` etc.
  passent par `behaves(kind, "harvester")`, voir §3 WP1) ;
- `cargo?: number` (récolteurs : capacité de cale, défaut `ECONOMY.harvesterCapacity`), `healTargets?:
  "ground"` (réparateur terrestre).

Les « contres » se lisent : *bat* = ce qu'elle bat à coût égal ; *craint* = ce qui la bat.

#### République

```ts
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
  cost: 175, hp: 230, speed: 2.4, sight: 7, domain: "ground", armor: "light",
  targets: "air", dps: 29, range: 5.5, shotInterval: 0.25, dmgType: "flak", fx: "flak",
  buildTime: 7, builtAt: "fab-plant", turret: true, radius: 0.38
},
branly: {
  name: "Canon Branly", role: "Canon électromagnétique : obus rapides, longue portée. Fragile de près.",
  nation: "republique",
  cost: 260, hp: 170, speed: 1.8, sight: 6, domain: "ground", armor: "light",
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
zenith: {
  name: "Zénith", role: "Croiseur aérien et base volante. Amarre-le pour produire, réparer et récolter partout.",
  nation: "republique", base: "goliath",
  cost: 1500, hp: 2600, speed: 1.3, sight: 11, domain: "air", armor: "heavy",
  targets: "both", dps: 105, range: 7,
  buildTime: 55, builtAt: "gantry", radius: 1.1, alwaysVisible: true
},
```

Armes du Zénith (même structure que `GOLIATH.weapons`, nouvelle table `ZENITH.weapons`, perdues dans cet
ordre) :

| Système | lostBelow | targets | dps | range | shotInterval | autres |
|---|---|---|---|---|---|---|
| Canons Branly de nacelle | 0,75 | ground | 30 | 7 (min 2,5) | 2 | splash 0,8, explosive, projectileSpeed 9 |
| Arc de proue | 0,5 | both | 26 | 5 | 0,8 | laser, airMult 0,8 |
| Soute à bombes | 0,25 | ground | 34 | 2 | 2 | splash 1,2, explosive, projectileSpeed 5 |
| Mitrailleuses de coursive | 0 | both | 15 | 3,5 | 0,4 | kinetic, airMult 0,7 |

Zénith, différences avec le Gargantua (`ZENITH` dans `balance.ts`) : **aérien** (seuls l'antiaérien et les
armes « both » le touchent — d'où 2 600 PV au lieu de 3 000 et 105 DPS au lieu de 125) ; **amarrage** 3 s /
**largage** 4 s au-dessus d'un sol constructible 2×2 (mât d'amarrage) ; amarré : point de dépôt, anneau de
construction 3 cases, **produit Éole, Blériot, Pasteur et Patrie** (au lieu de l'infanterie du Gargantua) et
compte comme source du Réseau électrique et du Réseau TSF ; pas de levage (il vole) ; coût +25 % par Zénith
déjà possédé ; réparé seulement par les Pasteur. Construit au **Hangar du Zénith** (gantry républicain).

#### Empire

```ts
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
},
```

(Temps de construction des unités impériales donnés **avant** le ×1,3 de la Vapeur, et des républicaines
avant le ×0,85 du Préfabriqué. Les temps effectifs : Mortier de 280 = 18,2 s, Jamais-Contente = 5,1 s.)

#### Toile des contres République ↔ Empire (cibles de `tools/balance.ts duels`, coût égal, ±0,1)

| Ligne bat colonne | cible | pourquoi |
|---|---|---|
| Jamais-Contente vs Creusot | +0,25 à +0,45 | laser ×1,55 contre lourd, 3 Jamais-Contente par Creusot |
| Panhard vs Jamais-Contente | +0,2 à +0,4 | blindage léger, PV faibles |
| Fusiliers vs Jamais-Contente | +0,3 à +0,5 | laser ×0,7 contre infanterie |
| Sapeurs-électriciens vs Creusot | +0,4 à +0,6 | |
| Creusot vs Sapeurs (écrasement) | +0,2 à +0,4 | `crushDps` 30 du Creusot |
| Hydroglisseur vs Creusot | +0,3 (actuel) | inchangé |
| Mortier de 280 vs Hotchkiss/Bobine (siège) | gagne sans pertes | portée 11 > 4–6,5 |
| Jamais-Contente / Éole vs Mortier de 280 | +0,6 | il ne voit qu'à 6 et ne tire pas sous 4 |
| Épervier vs Albatros, vs Zénith (par coût) | +0,3 | canon ×1,3 contre lourd |
| Blériot vs Épervier | +0,05 à +0,15 | léger avantage de portée/vitesse |
| Éole vs Épervier | −0,5 | (contre attendu) |
| De Dion vs Gyroptère | +0,6 | flak contre moyen ×1,0, cadence |
| Artificiers vs Zénith (à coût égal) | +0,2 | canon 1,3 × 1,5 contre l'air |
| Carabiniers vs Pioupious | +0,5 | précision ×3 |
| Chasseurs alpins vs Fusiliers | +0,4 | portée 7 contre 6,5, dissimulés dans les Bois |
| Zénith vs Gargantua (1 contre 1) | 45–55 % | duel de super-unités équilibré, `goliath` mode de `tools/balance.ts` |

### 1.6 Bâtiments par nation

Les **genres** de bâtiments (`BuildingKind`) restent partagés (le code de production, de dépôt, de file,
`hqOf`, etc. ne change pas), avec **nom, modèle et multiplicateurs par nation**. Seules les défenses armées
deviennent des genres propres (2 nouveaux `BuildingKind`), parce que `combat.ts` lit leurs armes dans
`BUILDINGS[kind]` à chaque tir.

| Genre (kind) | République | Empire |
|---|---|---|
| `hq` | **GQG** (modèle existant) | **Citadelle** (nouveau modèle) — DCA du GQG identique |
| `fab-plant` | **Garage électrique Jeantaud** (nouveau modèle) | **Forges** (existant) |
| `airpad` | **Parc de Chalais-Meudon** (existant) | **Aérodrome à vapeur** (nouveau) |
| `tech-lab` | **Polytechnique** (existant) | **Haut-fourneau** (nouveau) |
| `depot` | **Station de charge** (nouveau) | **Halles** (existant) |
| défense sol | **Bobine d'Arsonval** — nouveau kind `arsonval` (nouveau modèle) | **Hotchkiss** (`turret`, existant ; alimente les Tranchées) |
| défense AA | **Batterie Ruggieri** (`sam-site`, existant) | **Batterie de 47** — nouveau kind `flak-battery` (nouveau modèle) |
| `radar` | **Tour TSF** (existant ; pylône du Réseau, 150) | **Ballon captif** (nouveau modèle ; vision 13, rien d'autre) |
| `assembly-bay` | **Manufacture** (existant) | **Caserne-atelier** (nouveau) |
| `gantry` | **Hangar du Zénith** (nouveau ; construit le Zénith) | **Galerie des Machines** (existant ; construit le Gargantua) |

Les deux nouveaux genres :

```ts
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
},
```

Exigences (`requires`) inchangées dans leur logique : Polytechnique / Haut-fourneau exigent les trois usines ;
Hangar / Galerie exigent tout (`requiresAll`). La République n'a pas de Hotchkiss : la Bobine ne tire pas en
l'air, la Ruggieri couvre le ciel — sa défense « tout-en-un » est plus chère, c'est voulu (la République
défend par la mobilité).

### 1.7 Pouvoirs (4 par nation)

`PowerKind` gagne 4 valeurs : `"sonde" | "curie" | "gaz" | "pression"`. Liste par nation :
`POWER_SETS = { classique: ["barrage","emp","droppod","hammer"], republique: ["sonde","emp","droppod","curie"],
empire: ["barrage","gaz","pression","hammer"] }`. Le quatrième de chaque liste est la frappe tardive
(débloquée à 6:00 comme l'Obus Méliès actuel). Jauge de commandement, télégraphes publics, validation
`calldownBlocker` : inchangés.

| Pouvoir | Nation | Coût ⚡ | Recharge | Télégraphe | Rayon | Effet | Code |
|---|---|---|---|---|---|---|---|
| **Ballon-sonde** | Rép | 20 | 30 s | 0,5 s | 8 | Révèle la zone 20 s (dissimulation des tireurs comprise) ; le ballon est visible des deux camps | **nouveau** (source de vision dans `PowerState.reveals`) |
| **Fée Électricité** | Rép | 40 | 40 s | 0,8 s | 3 | Étourdit 4 s (existant `emp`) | existant |
| **Obus-capsule** | Rép | 70 | 60 s | 2 s | 1,2 | Équipage : 2 Jamais-Contente + 1 De Dion ; avec Polytechnique : 2 Hydroglisseurs + 1 De Dion | existant (`podCrew` par nation) |
| **Rayon Curie** | Rép | — | 150 s, dès 6:00 | 2,5 s | 2,2 | Unités : 300 × (1 − 0,5·d/r), tout blindage, sol et air ; bâtiments : 450 | réutilise `hammer` avec paramètres par pouvoir |
| **Feu roulant** | Emp | 60 | 45 s | 2,5 s | 2,9 | 3 obus de 170 (existant `barrage`) | existant |
| **Gaz de houille** | Emp | 35 | 40 s | 1 s | 3,5 | Nuage 12 s : l'ennemi ne voit pas les cases du nuage ; une unité ennemie n'acquiert une cible dans le nuage qu'à ≤ 2 cases | **nouveau** (masque de brouillard + filtre d'acquisition dans `combat.ts`) |
| **Pression des chaudières** | Emp | 45 | 55 s | 0,5 s | 4 | Véhicules terrestres impériaux dans le rayon : vitesse ×1,35, cadence ×1,25 pendant 10 s, puis **surchauffe** 3 s (étourdis, via la table `stunned`) | **nouveau** (table `buffs` id → tick de fin) |
| **Obus Méliès** | Emp | — | 150 s, dès 6:00 | 3 s | 2,5 | 260 unités / 700 bâtiments (existant `hammer`) | existant |

IA (`ai/powers.ts`) : Ballon-sonde quand un Mortier/Canon ennemi tire hors vision ou toutes les 90 s sur le
dernier GQG connu ; Gaz de houille sur sa propre colonne quand elle entre à portée d'une défense ennemie
(≥ 2 défenses connues à 6 cases) ; Pression au moment de lancer une vague (≥ 4 véhicules dans 4 cases) ;
Rayon Curie avec la même règle que l'Obus Méliès (amas ≥ 800).

### 1.8 Plan d'équilibrage

**Objectifs chiffrés**
- Rép vs Emp : chaque nation gagne **45–55 %** des parties décidées, sur l'ensemble des cartes ; **40–60 %**
  sur chaque carte prise seule (l'Archipel peut favoriser la République : accepté jusqu'à 60 %).
- Miroirs Rép-Rép et Emp-Emp : part du camp rouge **45–55 %** (contrôle d'équité, comme `--mirror`).
- Nulles (25:00) < 8 % ; durée médiane 9–15 min (l'actuel) ; aucune personnalité d'une nation < 35 % contre
  l'ensemble des personnalités de l'autre.
- Duels : les contres du §1.5 tiennent (aucune unité nouvelle ne bat **toutes** les unités adverses à coût égal).
- Classique : tableau de `DESIGN.md` « Balance & pacing » **identique** (aucun changement de stat partagée).

**Outils** (étendus en WP4)
1. `npx vite-node tools/balance.ts duels --nations` : matrice 15 × 16 Rép (lignes) × Emp (colonnes) à 1 800 de
   charbon. Ne prend pas en compte Réseau/Tranchées (duel en terrain nu) — ajouter `--trench` (escouades
   impériales pré-retranchées) et `--tsf` (Tour TSF républicaine sur place) pour l'encadrement.
2. `tools/balance.ts goliath --vs zenith` : Gargantua (+N Ateliers) contre Zénith (+N Pasteur), et chaque
   super-unité contre des groupes de coût égal de l'autre nation.
3. `tools/balance.ts siege` (nouveau mode) : 3 Hotchkiss + 1 Ruggieri (ou 2 Bobines + 1 Ruggieri) contre un
   groupe de siège de coût égal, temps pour raser.
4. `npx vite-node tools/pacing.ts run out.jsonl --nations rep-emp --seeds 8` puis `--nations rep-rep`,
   `emp-emp` : chaque couple de personnalités (pools du §1.10) × 6 cartes × 8 graines, les deux nations
   jouant chacune de chaque côté (bleu/rouge interverti) — ~1 500 parties par panel, ±3 %. Partager en
   `--shard i/n` sur plusieurs processus. `summary` ajoute : victoires par nation, par carte, valeur
   produite par rôle, part du radium dans la récolte.
5. Leviers, dans cet ordre (du moins au plus invasif) : `NATIONS.*.radiumValue`/`coalRate` →
   `unitTime`/`buildingCost` → coûts d'unités nouvelles → PV des unités nouvelles → seuils d'IA
   (`STRATEGIES.*.assaultValue`). Jamais de stat d'une unité existante (elle vit aussi en Classique).
   Chaque passe : `--tune '{"NATIONS.empire.coalRate":1.1}'` en A/B, une variable à la fois.

### 1.9 IA : jouer chaque nation

**Table des rôles** (nouveau, `ai/roles.ts`) : l'IA ne nomme plus des genres mais des rôles.

```ts
export type Role = "worker"|"scout"|"light"|"aa"|"artillery"|"siege"|"heavy"|"antiArmour"|"airStrike"|
  "interceptor"|"bomber"|"healer"|"line"|"at"|"sniper"|"transport"|"super";
export const ROLES: Record<Nation | "classique", Record<Role, UnitKind>> = {
  classique:  { worker:"harvester", scout:"scout", light:"stinger", aa:"flak-crawler", artillery:"mortar", siege:"mortar",
                heavy:"mastodon", antiArmour:"lancer", airStrike:"wasp", interceptor:"raptor", bomber:"hornet",
                healer:"mender", line:"trooper", at:"rocket-squad", sniper:"sniper", transport:"condor", super:"goliath" },
  republique: { worker:"fourgon", scout:"scout", light:"jamais-contente", aa:"de-dion", artillery:"branly", siege:"branly",
                heavy:"lancer", antiArmour:"jamais-contente", airStrike:"wasp", interceptor:"raptor", bomber:"hornet",
                healer:"mender", line:"trooper", at:"sapeurs", sniper:"sniper", transport:"condor", super:"zenith" },
  empire:     { worker:"harvester", scout:"estafette", light:"stinger", aa:"flak-crawler", artillery:"mortar", siege:"mortier-280",
                heavy:"mastodon", antiArmour:"mastodon", airStrike:"gyroptere", interceptor:"epervier", bomber:"vulcain",
                healer:"atelier", line:"fusiliers", at:"rocket-squad", sniper:"carabiniers", transport:"titan", super:"goliath" },
};
```

`runFabs`/`runPads`/`runBays` réécrits par rôle et produits **là où le genre se construit**
(`UNITS[k].builtAt` : l'Estafette et l'Atelier sortent des Forges). Avec la table `classique`, l'IA doit
émettre **exactement** les mêmes commandes qu'aujourd'hui (test de non-régression sur hachages).
Ajustements par nation :
- République : `airOnly`/`skyforce` naturels ; Zénith au lieu du Gargantua (`wantGoliath` → `wantSuper`),
  amarrage au-dessus d'un champ éloigné ; place une Tour TSF avant chaque bâtiment hors du rayon du GQG ;
  envoie les Fourgons d'abord sur le radium connu.
- Empire : Hotchkiss d'abord près des champs de charbon (Tranchées) ; Mortier de 280 escorté d'une Estafette
  ou d'un Ballon captif dès `enemyDefenses ≥ 2` ; deux Titans pour lever le Gargantua (logique de levage
  existante avec `transport` au lieu de `condor`).

**Personnalités par nation** (`DIFFICULTY[d].pool` filtré par `strategyFits` étendu à la nation) :

| Personnalité | République | Empire | Remarque |
|---|---|---|---|
| balanced | oui | oui | |
| rush | « Éclair » : Jamais-Contente + pioupious, Tour TSF avancée | Panhard + fusiliers | |
| airswarm | oui | oui (Gyroptères) | |
| skyforce | oui (signature) | non | Empire : aviation trop chère |
| boom | non | oui (signature charbon) | |
| ironclad | non | oui (Creusot + Artificiers) | |
| **siege** (nouvelle) | non | oui | `buildOrder: ["fab-plant","turret","tech-lab","assembly-bay","radar","airpad","turret","fab-plant"]`, `harvesters: 4`, `assaultValue: 2200`, `harassGroup: 4`, `heavy: true`, `siege: true` (2–3 Mortiers de 280 par vague, Ballon captif avancé) |
| **volta** (nouvelle) | oui | non | `buildOrder: ["fab-plant","radar","assembly-bay","airpad","radar","tech-lab","depot"]`, `harvesters: 5`, `assaultValue: 1500`, `harassGroup: 3`, `infantry: 0.35`, `groundRaids: true` (Sapeurs + Hydroglisseurs, Réseau TSF poussé vers le centre) |

Ordres de construction : les `buildOrder` existants restent valables (genres partagés) ; la République
remplace `turret` par `arsonval` + `sam-site`, l'Empire `sam-site` par `flak-battery` (substitution
automatique `buildingFor(nation, kind)`).

### 1.10 Compatibilité, replays, multijoueur

- **Config** : `MatchSetup.nations?: Partial<Record<Faction, Nation>>` (`setup.ts`) et `MatchOptions.nations`
  (`maps.ts`). Absent = Classique. Les deux camps ont une nation ou aucun (pas de Classique contre nation).
- **Règles** : `Rules.nations?: Record<Faction, Nation>` ; `applyMutators` doit installer des `rules` même sans
  mutateur quand des nations sont données. Toute la logique lit `rulesOf(w).nations?.[f]` → `nationOf(w, f)`
  renvoie `"classique"` sinon.
- **Effectifs** : `bannedBy` ajoute un motif « Réservé à la République / à l'Empire » ; en Classique, tout genre
  avec `nation` est banni (les commandes de l'IA classique ne les demandent jamais, donc aucun effet sur
  les hachages).
- **Mutateurs** : les listes `NO_GROUND_COMBAT`, `NO_VEHICLES`, `INFANTRY_SQUADS`, `GROUND_COMBAT` deviennent des
  fonctions de la nation (construites depuis `ROLES` + `domain`). Armada / Nomades : le Zénith ne s'y applique
  pas en v1 (`conflicts` : Nomades et Armada imposent Classique ou Empire).
- **Départ** : `createMapWorld` fait apparaître `ROLES[n].worker` et `ROLES[n].line` au lieu de
  `harvester`/`trooper` ; l'Archipel donne `ROLES[n].transport` (Titan pour l'Empire) ; `lifeline.ts` idem.
- **Replays (`BattleRecord`)** : champ `nations?` ; absent = Classique ; `setupWorld(r)` le transmet. Le viewer
  affiche les blasons. `tools/arena.ts` : `--nations rep,emp` (bleu, rouge) ; seats inchangés.
- **Duel sonore** : `HostOffer.nation` (nation de l'hôte) et choix de l'invité renvoyé dans la poignée de
  main ; `LOBBY_PROTO = 2` (2 bits par nation : 0 Classique, 1 Rép, 2 Emp). Un téléphone en proto 1 ne
  peut jouer qu'en Classique : l'hôte proto 2 le propose automatiquement. Le `setupHash` couvre les nations
  (elles changent le monde initial).
- **Hachage** : `checksum.ts` n'ajoute `nation`, `still`, `unpowered`, `buffs`, `reveals`, `clouds` que s'ils
  sont présents.
- **UI** : sélecteur de nation dans l'écran escarmouche (trois cartes : République / Empire / Classique, avec
  blason, portrait du chef — Capitaine Valmont / Maréchal Mâchefer — et 3 lignes de résumé) ; choix
  « Adversaire : nation aléatoire » ; blason dans le HUD (coin du compteur de charbon) ; blasons et noms de
  nation sur l'écran de fin et le rapport ; noms de bâtiments et d'unités résolus par
  `displayName(kind, nation)` partout (barre de construction, info-bulles, annonces, `lexicon.ts`).

### 1.11 Briefs de modèles 3D, FX et son

Conventions (celles de `three/belle/*`) : primitives `hullB()/partB()`, `block/drum/cyl/tube`, laiton
`BRASS`, toile `CANVAS`, acier `GM/GM_D`, couleur d'équipe `t.main/t.dark/t.light`. **Tout modèle porte une
tache de couleur d'équipe d'au moins 30 % de sa surface vue de dessus** (la caméra est haute). Taille = rayon
du sim × échelle de `models.ts` (`unitScale`). Silhouettes : République = courbes, verre, laiton, toile ;
Empire = rivets, cheminées, plaques, fumée noire.

| Unité | Forme | Couleur d'équipe vue de dessus | Taille | FX / son |
|---|---|---|---|---|
| Fourgon Jeantaud | fourgon de livraison capitonné, roues à rayons, bacs de batteries à l'arrière, perche électrique | toit entier | 1,0 | ronronnement électrique, étincelle au déchargement |
| Jamais-Contente | obus-torpille sur 4 roues fines, pilote, arc sur le capot | fuseau avant | 0,85 | arc bleu (fx `laser`), sifflement aigu, traînée d'étincelles en vitesse |
| Autocanon De Dion | tricar avec canon-revolver vertical sur pivot | plateau arrière + bouclier | 0,95 | rafale de flak, claquement sec |
| Canon Branly | affût à bobines cuivrées autour d'un tube long, roues pleines | bobines (anneaux) | 1,1 | nouvel fx `arc-shell` : obus lumineux bleu, détonation « zap-boum » |
| Sapeurs-électriciens (×3) | automates à sac de batteries, lance à arc | sac dorsal + casque | gabarit escouade | grésillement, arc court |
| Zénith | dirigeable rigide de 3,5 cases, nacelle-coursive vitrée, 4 hélices, mât de proue, flancs en fuseau | **bande dorsale complète** + empennages | 2,6 | ronronnement grave, projecteurs ; amarrage : câbles descendant au sol ; 4 points d'armes visibles (nacelles) qui s'éteignent avec les dégâts |
| Estafette | motocyclette à vapeur, side-car, cheminée | réservoir + side-car | 0,7 | teuf-teuf, petite fumée |
| Mortier de 280 | énorme mortier sur affût-locomobile à chenilles, tube court et gros | plaque d'affût | 1,4 | nouvel fx `heavy-shell` : départ à fort recul, sifflement long, cratère + secousse caméra légère |
| Gyroptère | coque de chaudière ovale sous un grand rotor libre, hélice arrière | coque supérieure | 1,0 | rotor (`rotors`), canon `cannon`, panache de vapeur |
| Épervier | biplan trapu à chaudière, cheminée derrière le pilote | ailes supérieures | 0,95 | mitrailleuses, fumée noire |
| Vulcain | dirigeable court et blindé, plaques rivetées, soute | dos blindé | 1,5 | bombes `bomb`, ronflement de chaudière |
| Atelier roulant | locomobile à grue et établi, chaudière verticale | toit de l'atelier | 1,1 | bras de grue animé, étincelles de soudure (rayon de réparation existant teinté orangé) |
| Fusiliers (×5) | automates à casque à pointe arrondi (non réaliste, joujou), plastron | plastron + casque | escouade | fusils `rifle`, sacs de sable quand retranchés |
| Carabiniers (×2) | automates à longue carabine, cape | cape | escouade | `snipe`, lentille qui brille |
| Titan | dirigeable-cargo ventru, nacelle-cale, crochets de levage | ballon entier | 1,6 | treuil, crochets ; levage du Gargantua par deux Titans |

| Bâtiment nouveau | Forme | Couleur d'équipe |
|---|---|---|
| Garage électrique (Rép) | halle à verrière en arc, portail, pylône sur le toit | verrière teintée |
| Station de charge (Rép) | kiosque à coupole avec bornes et câbles | coupole |
| Bobine d'Arsonval (Rép) | colonne de spires cuivrées, sphère au sommet, arc visible quand alimentée | socle + sphère |
| Hangar du Zénith (Rép) | hangar à dirigeable allongé 3×3, portes coulissantes, mât d'amarrage | toit |
| Citadelle (Emp) | donjon d'acier riveté, cheminées, horloge | toit et bannières |
| Aérodrome à vapeur (Emp) | piste courte, tour à charbon, catapulte | piste peinte |
| Haut-fourneau (Emp) | cheminée haute, cuve incandescente, wagonnets | cuve + toiture |
| Batterie de 47 (Emp) | 2 canons à long tube sur plateforme ronde blindée | plateforme |
| Ballon captif (Emp) | ballon sphérique attaché à un treuil, nacelle d'observateur | ballon entier |
| Caserne-atelier (Emp) | longue bâtisse de briques à sheds, portes d'automates | sheds |
| Tour Eiffel (accessoire de campagne) | treillis 3 étages, ~6 cases de haut, empreinte 3×3 | drapeau au sommet seulement |

Voix (`voice-lines.ts`, `voice-manifest.ts`) : chaque nation a son annonceur — République : la voix
d'officier existante (« Capitaine Valmont ») ; Empire : nouvelle voix, basse et emphatique (« Maréchal
Mâchefer » pour la campagne, « Commandant impérial » en escarmouche). Lignes nouvelles : 15 unités × 2
(prête, perdue), 12 bâtiments, 4 pouvoirs × 2, 6 lignes de mécanique (« Bâtiment hors réseau », « Infanterie
retranchée », « Surchauffe ! », etc.).

### 1.12 Ce qui est réellement du code nouveau

| Mécanique | Taille | Risque |
|---|---|---|
| `base` + `behaves()` : remplacement des tests de genre codés en dur (~115 sites : `"harvester"` 40, `"condor"` 30, `"mender"` 19, `"goliath"` 26) | moyenne, mécanique | moyen (non-régression Classique) |
| Rôles de l'IA (`ai/roles.ts`) | moyenne | moyen |
| Multiplicateurs de nation (coût/temps/PV, cale, radium, charbon) | petite | faible |
| Production parallèle (Vapeur) | petite | faible |
| Réseau électrique (placement + alimentation) | moyenne | moyen (IA de placement) |
| Réseau TSF (vitesse/vision) | petite | faible |
| Tranchées | petite | faible |
| Zénith : Gargantua aérien (amarrage en vol, production aérienne, armes `ZENITH`) | **grande** | **élevé** — repli v1 : Zénith = gros croiseur sans amarrage (armes seules) |
| Atelier roulant (soin restreint au sol) | petite | faible |
| Titan : capacité 3, levage du Gargantua | petite (paramétrique) | faible |
| Pouvoirs Ballon-sonde, Gaz de houille, Pression | moyenne | moyen (Gaz : acquisition) |
| Rayon Curie | petite (paramètres de `hammer`) | faible |
| FX `arc-shell`, `heavy-shell` | rendu seul | faible |
| Nouveau but de mission `reach` (§2) | petite | faible |
| Mission : `bannedPowers` par camp, `nations` par op, intertitres | petite | faible |

---

## 2. La Campagne de 1900

### 2.1 Prémisse

Le film d'intro s'achève sur « Paris, 1900. L'Europe s'arme de vapeur, d'acier et de radium… ». La campagne
reprend là : l'Exposition universelle ferme ses portes ; dans la Galerie des Machines, l'Empire de Carbonie a
exposé son Gargantua, et la République son Zénith en construction. Le **Maréchal Mâchefer** n'est pas venu pour
les médailles : il veut le **radium de la chimiste Marguerite Sablon**, qui ferait marcher ses chaudières sans
charbon, et compte bien faire défiler son Gargantua sous la Tour Eiffel. Feuilleton en 12 épisodes : poursuites,
îles bretonnes, cols alpins, volcans d'Auvergne, retour à Paris.

### 2.2 Personnages

| Personnage | Rôle | Voix / présence |
|---|---|---|
| **Capitaine Hippolyte Valmont** | officier républicain, narrateur ; panache et moustache | la voix d'annonceur existante ; « héros » de campagne : son Hydroglisseur (rang 3, nom « Valmont ») apparaît dans 4 missions, but `protect` |
| **Anatole Ferrand** | ingénieur de Polytechnique, inventeur du Zénith | conseils de construction ; ses intertitres débloquent les unités |
| **Marguerite Sablon** | chimiste du radium (hommage, pas biographie) | la convoitée ; débloque Rayon Curie |
| **Maréchal Mâchefer** | chef de l'Empire de Carbonie ; grandiloquent, un peu ridicule, jamais cruel | voix impériale ; joué par le joueur dans les intermèdes 4 et 6 |

Les « héros » à la Warcraft III réutilisent les vétérans existants (`heroes.ts`) : une unité nommée au rang 3
posée par `setup`, avec un `tag` ; pas de nouveau système.

### 2.3 Progression

- 12 missions en 3 actes ; ordre linéaire ; `OPS_OPEN_AT_START = 1` pour la campagne (puis +1 par mission
  gagnée). Les anciens identifiants d'op sont conservés pour la carrière (records, étoiles déjà gagnées).
- Difficulté de l'IA : Facile (1–2), Normal (3–8), Difficile (9–12).
- Déblocages : une table `CAMPAIGN_UNLOCKS` cumulative ; chaque op calcule ses `playerBans` = tout l'effectif
  de la nation jouée moins ce qui est débloqué ; nouveau `rules.sideBans[f].powers` pour les pouvoirs.
- Nouveau type de but : `{ type: "reach"; tag: string; x: number; y: number; radius: number; count: number;
  label: string }` — au moins `count` entités tagguées dans la zone (accomplissement). Tous les autres buts
  existent déjà (`destroyHq`, `destroy`, `survive`, `waves`, `deliver`, `protect`, `within`, `maxLosses`).
- Les buts qui nomment un genre (`destroy kind`, `maxLosses kind`) utilisent le genre de la nation concernée
  (ex. « 4 Fourgons Jeantaud » et non `harvester`).
- `OpDef` gagne : `nations: { player: Nation; enemy: Nation }`, `act: 1|2|3`, `cards: { before: string[];
  win: string; lose: string }`, `dressing?: "paris" | "polygone"` (habillage de rendu de la carte, sans effet sim).
- Les intertitres s'affichent dans le style des cartons du film (`title.ts`) : fond noir, cadre art nouveau,
  12 mots maximum, 2,5 s chacun, toucher pour passer.

### 2.4 Tableau des déblocages

| Après la mission | République | Empire |
|---|---|---|
| départ (M1) | Fourgon, Jamais-Contente, De Dion, Pioupious ; GQG, Garage, Station, Bobine, Tour TSF, Manufacture ; Ballon-sonde | — |
| M2 | + Chalais-Meudon, Patrie, Éole, Blériot ; Fée Électricité | — |
| M3 | + Montgolfière, Hydroglisseur, Sapeurs, Polytechnique, Ruggieri ; Obus-capsule | — |
| M4 (Empire) | — | Fardier, Estafette, Panhard, Faucheux, Fusiliers, Artificiers, Canon de 75, Mortier de 280 ; Citadelle, Forges, Halles, Hotchkiss, Batterie de 47, Ballon captif, Caserne, Haut-fourneau ; Tranchées ; Feu roulant, Gaz de houille |
| M5 | + Canon Branly, Chasseurs alpins, Pasteur | — |
| M6 (Empire) | — | + Creusot, Atelier roulant, Aérodrome, Gyroptère, Épervier, Titan ; Pression des chaudières |
| M8 | + Albatros | — |
| M9 | + Rayon Curie | — |
| M11 | + Hangar du Zénith, Zénith | — |
| Fin de campagne | effectifs complets en escarmouche « nation » (déjà disponibles hors campagne) | Vulcain, Carabiniers, Gargantua sont vus chez l'ennemi |

L'escarmouche n'est **pas** verrouillée par la campagne (on joue les nations tout de suite).

### 2.5 Les 12 missions

Positions en cases ; à vérifier avec `npm run maps` / `tools/export-maps.ts`. Joueur toujours au camp bleu
(comme aujourd'hui) ; la nation est indépendante du camp.

---

#### ACTE I — « L'Ultimatum »

**M1 — Tête de pont** (ex-op `bridgehead`) · Terres fluviales · **République** contre Empire
- IA : `rush` **Normal** (était Difficile), `tweak: { assaultValue: 1600, harvesters: 3 }`.
- Mise en place : existante, unités converties — Hotchkiss du pont → 2 Bobines d'Arsonval (tag `bridge`) + une
  Tour TSF à (20, 28) pour les alimenter ; 3 Jamais-Contente + 1 De Dion ; Station de charge à (20, 31).
  Rouge : Forges à (50, 10), 6 Panhard, 1 000 de charbon.
- Buts : `survive 240` ; `protect bridge min 1` (« Garde une Bobine du pont debout »).
- Étoiles : `maxLosses 6` ; `protect bridge min 2`.
- Changement : enseigne le Réseau électrique (si la Tour tombe, les Bobines s'éteignent).
- Cartons avant : « Paris, 1900. L'Exposition ferme ses portes. » · « L'Empire de Carbonie franchit le fleuve sans y être invité. » · « Capitaine Valmont : “Personne ne passe ce pont.” »
- Victoire : « Le pont tient. Le Maréchal Mâchefer fronce un sourcil. »
- Défaite : « Le pont est tombé. Paris l'apprendra par télégraphe. »

**M2 — La Caravane du radium** (ex-op `harvest-moon`) · Mer de dunes · **République** contre Empire
- IA : `airswarm` Normal (Empire : Gyroptères), `tweak: { harassGroup: 2 }`.
- Mise en place : 1 Fourgon, 1 Bobine + 1 Ruggieri (au lieu de la Hotchkiss), rouge : 3 Gyroptères.
- Buts : `deliver 11000` (était 10 000 : le radium républicain paie plus) ; `within 300`.
- Étoiles : `maxLosses 1 kind fourgon` ; `within 240`.
- Cartons : « Dans le désert, Marguerite Sablon a trouvé du radium. » · « Il faut le ramener avant le départ du convoi. » · « Au loin, des rotors. Des Gyroptères ! »
- Victoire : « Le convoi part. Sablon serre une fiole qui luit. » · Défaite : « Les Fourgons brûlent dans les dunes. Le radium est perdu. »

**M3 — Les Côtes de granit** (NOUVELLE) · Archipel (Bretagne) · **République** contre Empire
- IA : `balanced` Normal, `tweak: { assaultValue: 2400 }`, `enemyIncome: 0.85`.
- Mise en place : la carte donne déjà Montgolfière + escouade à bord (règles îles). Bleu : + 1 Hydroglisseur
  « Valmont » (tag `valmont`, rang 3). Rouge : 3 Ballons captifs (tag `antenne`) posés par `setup` — un sur
  l'île du centre (≈ 54, 50), un sur l'île extérieure (≈ 18, 22), un sur l'île du golfe nord-ouest
  (≈ 35, 12) — chacun gardé par 1 Hotchkiss et 1 Escouade de fusiliers retranchée.
- Buts : `destroy radar count 3` ; `within 720` ; `protect tag valmont min 1`.
- Étoiles : `maxLosses 0 kind condor` ; `within 540`.
- Enseigne : Montgolfière, Hydroglisseur sur les hauts-fonds, Tranchées vues de l'autre côté.
- Cartons : « Bretagne. Des ballons impériaux espionnent nos côtes. » · « Ferrand : “Les Hydroglisseurs passent là où rien ne roule.” » · « Abattez les trois ballons captifs. »
- Victoire : « Les ballons crèvent. L'Empire est sourd et aveugle. » · Défaite : « Le Capitaine boit la tasse. Les espions rient. »

**M4 — Pendant ce temps, en Carbonie…** (NOUVELLE, intermède) · Terres de cendres (Auvergne) · **Empire** contre République
- Le joueur incarne le Maréchal (ton comique : « l'Empire a ses raisons, et ses moustaches »).
- IA : `balanced` Facile, `tweak: DEFENSIVE` (ne fait que défendre), République sur le plateau extérieur.
- Mise en place : bleu (Empire) : Citadelle, Forges, Haut-fourneau, 1 Mortier de 280, 1 Estafette,
  2 Escouades de fusiliers, 1 500 de charbon. Rouge (Rép) : 3 Bobines d'Arsonval + 1 Ruggieri autour d'une
  Polytechnique (tag `institut`) à ≈ (52, 12) ; une Tour TSF qui les alimente.
- Buts : `destroy arsonval count 3` ; `destroy tech-lab count 1` ; `within 540`.
- Étoiles : `maxLosses 5` ; `within 360`.
- Enseigne : Mortier de 280 (portée 11), guetteur (Estafette/Ballon captif), Tranchées, Gaz de houille.
- Cartons : « Pendant ce temps, dans les volcans de Carbonie… » · « Mâchefer : “Montrez-moi la portée de mon Mortier !” » · « Cible : l'observatoire républicain du plateau. »
- Victoire : « Le Maréchal jubile. À Paris, on fronce les deux sourcils. » · Défaite : « Le Maréchal casse sa longue-vue de dépit. »

---

#### ACTE II — « La Guerre des cimes »

**M5 — Marée d'acier** (ex-op `iron-tide`) · Engelure (Alpes) · **République** contre Empire
- IA : `ironclad` Normal (était Difficile en Classique ; l'Empire a ici des Creusot **et** des Mortiers de 280),
  `tweak: { siege: false }` (pas de Mortier de 280 avant 4:00).
- Mise en place : Garage + Polytechnique + 1 Fourgon (comme l'op actuelle, bâtiments convertis) ; + 1 Tour TSF.
- Buts : `survive 360`. Étoiles : `destroy mastodon count 2` ; `maxLosses 1 buildings`.
- Cartons : « Les Alpes. Une colonne d'acier descend vers la vallée. » · « Ferrand : “Le laser aime l'acier épais.” » · « Tenez six minutes. Les secours arrivent. »
- Victoire : « La colonne recule dans la neige. » · Défaite : « Les Creusot passent le col. La vallée est perdue. »

**M6 — Avoirs gelés** (ex-op `frozen-assets`) · Engelure · **Empire** contre République
- Le joueur reprend le Maréchal : sa colonne est prise par les glaces, sans revenu.
- IA : `boom` Normal (République : Fourgons nombreux), `skyforce` exclu.
- Mise en place : Forges, Aérodrome, Haut-fourneau ; 3 000 de charbon ; pas de Fardier ; pas de pouvoirs
  (`calldowns: false`, comme aujourd'hui).
- Buts : `destroyHq` ; `within 360`. Étoiles : `destroy fourgon count 4` ; `within 240`.
- Enseigne : production parallèle Vapeur, Creusot, Atelier roulant, Titan.
- Cartons : « Le Maréchal est pris dans la glace. Ses coffres aussi. » · « 3 000 de charbon, pas un de plus. » · « Mâchefer : “Frappons avant que leur radium ne paie !” »
- Victoire : « Le Maréchal s'échappe vers ses volcans, ravi. » · Défaite : « Le Maréchal grelotte. Ses chaudières aussi. »

**M7 — Le Col des Aigles** (NOUVELLE) · Engelure · **République** contre Empire
- Escorter le convoi de radium de Sablon à travers le col jusqu'au tunnel ferroviaire.
- IA : `boom` Normal, `tweak: { harassGroup: 2, assaultValue: 1800 }`.
- Mise en place : bleu : 3 Fourgons tagués `convoi` (cale pleine, ne récoltent pas : ordre `move` initial),
  Hydroglisseur « Valmont », 2 Jamais-Contente, 1 De Dion, 1 Pasteur. Rouge : 3 Hotchkiss en embuscade sur la
  route du col (≈ (20, 22), (26, 16), (32, 12)) + 2 Escouades de fusiliers retranchées.
- Buts : `reach tag convoi x 30 y 6 radius 3 count 2` (« Amène 2 Fourgons au tunnel ») ; `protect tag convoi
  min 2` ; `within 480`.
- Étoiles : `protect tag convoi min 3` ; `within 360`.
- Cartons : « Le radium doit passer le col avant la nuit. » · « Sablon : “Doucement avec mes fioles, Capitaine !” » · « Des tranchées barrent la route. »
- Victoire : « Le train file vers Paris, chargé de lumière. » · Défaite : « Le radium est aux mains du Maréchal. »

**M8 — Pirates du ciel** (ex-op `sky-pirates`) · Terres de cendres · **République** contre Empire
- Raid aérien sur les forges volcaniques entrevues en M4.
- IA : `balanced` Facile, `tweak: DEFENSIVE`, `enemyIncome: 0.5` (inchangé).
- Règles : `playerBans` = tout combat terrestre républicain + Montgolfière + Garage + Manufacture (calculé
  par rôle).
- Mise en place : Chalais-Meudon, Polytechnique, 1 Fourgon ; rouge : 2 Batteries de 47 + 1 Hotchkiss.
- Buts : `destroyHq` ; `within 420`. Étoiles : `maxLosses 12` ; `within 270`.
- Cartons : « Auvergne. Les volcans fument : le Maréchal forge. » · « Ferrand : “Un Albatros tout neuf. Ne le cassez pas.” » · « Par les airs, et seulement par les airs. »
- Victoire : « La Citadelle s'écroule dans la lave. Mâchefer s'enfuit à cheval. » · Défaite : « Nos ailes fondent au-dessus des cratères. »

---

#### ACTE III — « Paris ! »

**M9 — L'Orage de radium** (ex-op `glass-jaw`) · Mer de dunes · **République** contre Empire
- Récit du mutateur : un orage de radium surcharge toutes les machines (Canons de verre + Production éclair).
- IA : `rush` Difficile, `tweak: { harvesters: 4 }`. Règles : `mutators: ["glass", "rapidfab"]`.
- Buts : `destroyHq` ; `within 360`. Étoiles : `maxLosses 0 buildings` ; `within 240`.
- Débloque : Rayon Curie (après victoire).
- Cartons : « Un orage de radium éclate sur le désert. » · « Tout frappe double. Tout se bâtit double. » · « Sablon : “J'ai une idée… un rayon.” »
- Victoire : « Le Rayon Curie est né. Le Maréchal l'a vu. » · Défaite : « L'orage a tout emporté, y compris nos plans. »

**M10 — Décapitation** (ex-op `decapitation`) · Terrain d'essai, habillé « Polygone de Carbonie » · **République** contre Empire
- IA : `balanced` Difficile, `tweak: DEFENSIVE`. Règles : tout banni, revenu 0, pas de pouvoirs (inchangé).
- Groupe d'assaut (même valeur qu'aujourd'hui, ≈ 2 800) : 3 Hydroglisseurs (dont « Valmont »),
  3 Jamais-Contente, 2 Albatros, 2 Blériot, 2 Pasteur.
- Défenses rouges : 2 Batteries de 47 (au lieu des Ruggieri), 3 Hotchkiss, 2 Faucheux, 3 Éperviers.
- Buts : `destroyHq` ; `within 180`. Étoiles : `maxLosses 4` ; `within 120`.
- Cartons : « Le Polygone de Carbonie. Le quartier général du Maréchal. » · « Pas de renforts. Pas de seconde chance. » · « Valmont : “En avant, et avec panache !” »
- Victoire : « La Citadelle tombe… mais le Gargantua s'éloigne vers Paris ! » · Défaite : « L'assaut se brise. Le Maréchal applaudit, ironique. »

**M11 — Dernière lueur** (ex-op `last-light`) · Terres fluviales (en amont de Paris) · **République** contre vagues impériales
- Vagues du mode Survie composées par **rôles** de la nation Empire (thèmes : air = Gyroptères/Vulcains,
  blindé = Creusot, artillerie = Canons de 75 + Mortiers de 280, essaim = Fusiliers + Panhard, boss = Gargantua
  à la vague 10). `survival: { difficulty: "normal", firstWave: 45, interval: 40 }`.
- Mise en place : Garage, Chalais-Meudon, 2 Bobines, 1 Ruggieri, 2 Tours TSF, 2 Fourgons, 1 200 de charbon ;
  Hangar du Zénith débloqué : 1 Zénith offert à la vague 6 (« Ferrand l'a fini ! »).
- Buts : `waves 10`. Étoiles : `maxLosses 2 buildings` ; `within 420`.
- Cartons : « Les faubourgs. Paris voit déjà la fumée. » · « Ferrand : “Le Zénith sera prêt. Tenez !” » · « Dix vagues avant l'aube. »
- Victoire : « L'aube se lève. Le Zénith brille au-dessus de la Seine. » · Défaite : « Les faubourgs tombent. Paris éteint ses lampes. »

**M12 — La Dame de fer** (NOUVELLE, finale) · Terrain d'essai, habillé **Paris / Champ-de-Mars** · **République** contre Empire
- Spectacle : la Tour Eiffel au centre (accessoire 3D, empreinte 3×3) ; c'est une **Tour TSF** taguée `eiffel`
  (historiquement, l'antenne TSF de la Tour date de 1903 : clin d'œil), PV de Tour TSF ×4 via un
  multiplicateur d'op (`setup` : `hpMult` nouveau champ d'aide `o.building(..., { hpMult: 4 })`), elle
  alimente tout dans son rayon et donne le Réseau TSF.
- IA : `ironclad` Difficile, `tweak: { assaultValue: 2000 }`. Le Maréchal démarre avec **un Gargantua
  « Le Colosse »** en marche depuis le coin rouge vers la Tour, plus une Galerie des Machines.
- Bleu : base complète pré-posée au coin ouest (≈ 4, 40), Zénith offert, 2 000 de charbon, tous les pouvoirs
  républicains.
- Buts : `protect tag eiffel min 1` ; `destroy goliath count 1` ; `within 900`.
- Étoiles : `destroyHq` (la Citadelle rouge aussi) ; `maxLosses 2 buildings`.
- Fin : à la mort du Colosse, cinématique de finale existante (`finale.ts`) centrée sur la Tour, feu d'artifice
  Ruggieri (fx existants de calldown recolorés), carton final.
- Cartons : « Paris, 14 juillet. Le Colosse marche sur le Champ-de-Mars. » · « Mâchefer : “Votre Tour fera un joli tisonnier !” » · « Valmont : “Pas tant qu'il restera du panache.” »
- Victoire : « Le Colosse s'agenouille. La Tour salue. Vive le panache ! » — suivi de « FIN » et du générique.
- Défaite : « La Dame de fer chancelle. Le Maréchal ajuste son monocle. »

#### Récapitulatif

| # | Titre | Carte | Nation jouée | Op d'origine | IA | Difficulté |
|---|---|---|---|---|---|---|
| 1 | Tête de pont | riverlands | Rép | bridgehead | rush | Normal |
| 2 | La Caravane du radium | dune-sea | Rép | harvest-moon | airswarm | Normal |
| 3 | Les Côtes de granit | archipelago | Rép | **nouvelle** | balanced | Normal |
| 4 | Pendant ce temps, en Carbonie… | ashlands | **Emp** | **nouvelle** | balanced défensif | Facile |
| 5 | Marée d'acier | frostbite | Rép | iron-tide | ironclad | Normal |
| 6 | Avoirs gelés | frostbite | **Emp** | frozen-assets | boom | Normal |
| 7 | Le Col des Aigles | frostbite | Rép | **nouvelle** | boom | Normal |
| 8 | Pirates du ciel | ashlands | Rép | sky-pirates | balanced défensif | Facile (½ revenu) |
| 9 | L'Orage de radium | dune-sea | Rép | glass-jaw | rush | Difficile |
| 10 | Décapitation | proving-grounds (Polygone) | Rép | decapitation | balanced défensif | Difficile |
| 11 | Dernière lueur | riverlands | Rép | last-light | survie (Empire) | Normal |
| 12 | La Dame de fer | proving-grounds (Paris) | Rép | **nouvelle** | ironclad + Colosse | Difficile |

Les 8 ops existantes sont toutes reprises. Les anciennes versions Classique restent jouables dans un onglet
« Épreuves » (même `id` suffixé `-classique`) pour ne pas casser les tests `ops.test.ts` et `tests/ops-pilots.ts`.

---

## 3. Plan d'implémentation

### 3.1 Inventaire des actifs

| Catégorie | Nombre | Détail |
|---|---|---|
| Modèles d'unités nouveaux | **15** | Rép : Fourgon, Jamais-Contente, De Dion, Branly, Sapeurs (gréement d'escouade), Zénith (gréement spécial) ; Emp : Estafette, Mortier de 280, Gyroptère, Épervier, Vulcain, Atelier, Fusiliers (escouade), Carabiniers (escouade), Titan |
| Modèles de bâtiments nouveaux | **10** | Rép : Garage, Station de charge, Bobine d'Arsonval, Hangar du Zénith ; Emp : Citadelle, Aérodrome, Haut-fourneau, Batterie de 47, Ballon captif, Caserne-atelier |
| Accessoires | 2 | Tour Eiffel, habillage « Polygone » (barbelés, panneaux) |
| Portraits HUD (`tools/model-portraits.mjs`) | 25 | une par nouveau modèle |
| Blasons | 2 (+ 2 portraits de chef) | SVG/PNG pour menu, HUD, fin |
| FX | 4 | `arc-shell`, `heavy-shell`, nuage de Gaz de houille, ballon-sonde ; + halo Pression, anneau de Tranchée, éclair barré « hors réseau » |
| Voix | ~110 lignes | §1.11 |

### 3.2 Lots de travail (ordre et propriété des fichiers)

Règle : un fichier n'a qu'un lot propriétaire à la fois ; les autres lots demandent des changements par
message. Les registres partagés (`types.ts`, `balance.ts`, `belle/index.ts`, `lexicon.ts`) sont **gelés** après
WP0 sauf par leur propriétaire.

**Phase A — fondations (séquentiel, 1 agent)**

- **WP0 — Types, données, Classique intact.** Propriétaire : `src/sim/types.ts`, `balance.ts`, `lexicon.ts`,
  `setup.ts`, `rules.ts`, `src/game/three/belle/index.ts` (squelette d'enregistrement).
  `Nation`, nouveaux `UnitKind`/`BuildingKind`/`PowerKind`, champs `nation/base/cargo/healTargets`,
  `NATIONS`, `ZENITH`, `POWERS.sonde/curie/gaz/pression`, `ROLES`, `nationOf()`, `displayName()`,
  `MatchSetup.nations`, `Rules.nations`, bannissements. **Modèles provisoires** : chaque nouveau genre est
  rendu avec le modèle de son `base` ou d'un équivalent de rôle, teint de la couleur de nation (table
  `PLACEHOLDER_MODEL`), pour que tout le reste avance.
  Tests : `classic-hash.test.ts` (hachages des replays de `battles/showcase` et d'une partie IA-contre-IA de
  10 min identiques avant/après), `lexicon` (genre et pluriel de chaque nouveau nom), exhaustivité des
  `Record<UnitKind, …>`.

**Phase B — simulation (parallèle, 3 agents)**

- **WP1 — Mécaniques de nation.** Propriétaire : `economy.ts`, `movement.ts`, `fog.ts`, `combat.ts`,
  `infantry.ts`, `world.ts`, `placement.ts`, `transport.ts`, `powers.ts`, `checksum.ts`.
  `behaves()` à la place des tests de genre ; multiplicateurs ; Vapeur parallèle ; Réseau électrique ; Réseau
  TSF ; Tranchées ; Atelier ; Titan ; 3 pouvoirs nouveaux + Rayon Curie.
  Tests : `nations.test.ts` (chaque mécanique, unités sous et hors réseau, retranchement après 3 s et pas
  avant, gaz bloque l'acquisition à 2,5 cases mais pas à 1,5, surchauffe), déterminisme (deux mondes, mêmes
  commandes → même hachage), symétrie (`symmetry.test.ts` étendu aux miroirs).
- **WP2 — Zénith.** Propriétaire : `goliath.ts`, `lift.ts`, `ai/goliath.ts`.
  Généraliser le Gargantua par une table `SUPER[kind]` (armes, amarrage, production autorisée, domaine).
  Repli documenté si en retard : Zénith sans amarrage. Tests : `zenith.test.ts` (amarrage sur sol
  constructible seulement, production aérienne, perte d'armes par seuil, réparation par Pasteur seuls).
- **WP3 — IA.** Propriétaire : `ai/commander.ts`, `ai/roles.ts` (nouveau), `ai/powers.ts`, `ai/condor.ts`,
  `ai/airlift.ts`, `ai/menders.ts`, `ai/intel.ts`, `modes/survival.ts` (vagues par rôle).
  Rôles, personnalités `siege` et `volta`, pools par nation, placement sous réseau, guetteur de Mortier.
  Tests : `ai-nations.test.ts` (chaque personnalité de chaque nation construit son ordre et lance une vague
  avant 8:00 sur `riverlands`), non-régression Classique (mêmes commandes, même graine).

**Phase C — équilibrage et outillage (1 agent, puis boucle)**

- **WP4 — Outils.** Propriétaire : `tools/balance.ts`, `tools/pacing.ts`, `tools/pacing-match.ts`,
  `tools/arena.ts`, `src/arena/*`. Modes `duels --nations`, `siege`, `goliath --vs zenith`, `--nations` pour
  `pacing`, records avec `nations`. Puis passes d'équilibrage (§1.8) — seul lot autorisé à retoucher les
  nombres de `NATIONS`/nouvelles unités dans `balance.ts` après WP0 (par PR distincte). Rapport chiffré ajouté
  à ce document (section « Mesures »).

**Phase D — présentation (parallèle, jusqu'à 7 agents, peut démarrer dès la fin de WP0)**

- **WP5a — Modèles terrestres République** : `src/game/three/belle/ground-rep.ts` (nouveau) — Fourgon,
  Jamais-Contente, De Dion, Branly.
- **WP5b — Modèles terrestres Empire** : `belle/ground-emp.ts` — Estafette, Mortier de 280, Atelier roulant.
- **WP5c — Aéronefs Empire** : `belle/air-emp.ts` — Gyroptère, Épervier, Vulcain, Titan (crochets compatibles
  avec `render/goliath.ts` pour le levage).
- **WP5d — Infanterie** : `src/game/three/infantry.ts` (+ `belle-infantry-nations.ts` si besoin) — Sapeurs,
  Fusiliers (+ anneau de sacs de sable), Carabiniers.
- **WP5e — Zénith** : `src/game/three/zenith.ts`, `src/game/render/zenith.ts` (nouveaux) — gréement, armes
  qui s'éteignent, câbles d'amarrage.
- **WP5f — Bâtiments** : `belle/buildings-rep.ts`, `belle/buildings-emp.ts` (nouveaux) + Tour Eiffel
  (`belle/landmarks.ts`).
- **WP5g — FX, son, voix, portraits** : `render/belle-fx.ts`, `render/fx.ts`, `render/powers.ts`,
  `game/audio-belle.ts`, `game/voice-lines.ts`, `tools/voice-manifest.ts`, `tools/model-portraits.mjs`,
  `public/assets/ui/*`.
  Le propriétaire de WP0 fusionne les enregistrements dans `belle/index.ts` et retire `PLACEHOLDER_MODEL`
  genre par genre. Tests : `belle-models.test.ts` (chaque genre a un modèle non provisoire, tache d'équipe ≥ 30 %
  de l'aire vue de dessus mesurée par le test de rendu existant), `portraits.test.ts`, `belle-audio.test.ts`.

**Phase E — interface et multijoueur (1–2 agents)**

- **WP6 — UI.** Propriétaire : `src/ui/*` (sauf `ops.ts`), `src/main.ts`, `src/unit-info.ts`, `models.ts`
  (page des modèles), `src/game/controller.ts`, `src/game/advisor.ts`, `src/game/hints.ts`. Sélecteur de nation,
  blasons, écran de fin, info-bulles, conseiller de construction (réseau), page `models.html` par nation.
- **WP7 — Replays et duel sonore.** Propriétaire : `src/versus/*`, `src/game/replay.ts`, `src/ui/replay*.ts`.
  `LOBBY_PROTO = 2`, nation dans `HostOffer`, repli Classique avec un pair proto 1. Tests :
  `duel-fullstack.test.ts` (Rép contre Emp, puis proto 1 contre proto 2 → Classique).

**Phase F — campagne (1 agent, après B et D provisoire)**

- **WP8 — Campagne.** Propriétaire : `src/sim/ops.ts`, `src/game/ops.ts`, `src/ui/ops.ts`, `src/game/career.ts`,
  `tests/ops*.ts`. `OpDef.nations/act/cards/dressing`, but `reach`, `CAMPAIGN_UNLOCKS`, bannissement de
  pouvoirs, 12 missions, onglet « Épreuves » Classique, cartons. Tests : chaque mission est gagnable par
  `tests/ops-pilots.ts` étendu (pilote scripté) ; `ops.test.ts` vérifie que chaque op n'utilise que des genres
  de sa nation et que les déblocages sont cumulatifs.

### 3.3 Calendrier réaliste

| Étape | Lots | Dépend de | Durée relative |
|---|---|---|---|
| 1 | WP0 | — | 1 |
| 2 | WP1, WP2, WP3 (sim) ∥ WP5a–g (modèles) | WP0 | 3 |
| 3 | WP4 première passe (duels, siège, super-unités) | WP1, WP2 | 1 |
| 4 | WP3 fin + WP4 panel `pacing` complet ; corrections | 3 | 2 |
| 5 | WP6, WP7 | WP1 ; modèles provisoires suffisent | 2 |
| 6 | WP8 | WP1–WP3, WP6 | 2 |
| 7 | WP4 passe finale (avec campagne et modèles définitifs) ; captures, portraits | tout | 1 |

### 3.4 Risques

| Risque | Parade |
|---|---|
| Le refactor `behaves()` change un comportement Classique | test de hachage Classique en WP0, exécuté par chaque lot avant fusion |
| Zénith (Gargantua aérien) trop lourd à coder | repli v1 sans amarrage ; amarrage en v1.1 |
| Le Réseau électrique paralyse l'IA (placement) | le placement IA cherche d'abord dans le rayon des sources, sinon pose une Tour TSF ; test dédié |
| Radium rare : bonus républicain trop faible ou trop variable selon la carte | levier `radiumValue` et `coalRate` par nation ; mesure par carte ; au pire `NATIONS.republique.coalRate` 1,05 |
| Production parallèle de l'Empire = boule de neige | levier `unitTime` ; cap de 2 ; mesure de la valeur d'armée à 6:00 |
| Gaz de houille illisible | contour du nuage public (télégraphe) ; l'ennemi voit le nuage, pas ce qu'il cache |
| Mutateurs incohérents avec les nations | listes de bannissement calculées par rôle ; `conflicts` Nomades/Armada ↔ République |
| Duel sonore : désaccord de protocole | proto 2 négocié, repli Classique automatique |
| Performances mobile (25 nouveaux modèles) | budget : ≤ 600 triangles par unité, ≤ 1 500 par bâtiment, ≤ 4 000 pour le Zénith ; instanciation existante |
| Ton : glissement vers le réel | relecture des cartons : pas de pays, de batailles ou d'uniformes réels ; Empire comique, jamais cruel |

### 3.5 WP0 — fait

Livré sur `feat/camps`. Classique vérifié bit pour bit : `tests/classic-hash.test.ts` rejoue les 9 records de
`battles/showcase` et 3 parties IA-contre-IA de 10 min (riverlands, archipelago, frostbite + Nomades) et compare
hachages `worldHash` tous les 500 ticks, fin de partie et empreinte des commandes de l'IA aux valeurs calculées
sur `4eff7f6` (avant tout code de nation). Tests de données : `tests/nations-data.test.ts`.

Où trouver quoi :
- `types.ts` : `Nation`, `NationOrClassic`, `Role`, `ClassicUnitKind`/`NationUnitKind`,
  `ClassicBuildingKind`/`NationBuildingKind`, `ClassicPowerKind`/`NationPowerKind`, `WeaponFx` + `arc-shell`, `heavy-shell`.
- `balance.ts` : les 15 unités et 2 défenses (ajoutées **après** les genres Classique : l'ordre des clés reste
  le même pour le Classique), champs `nation/base/cargo/healTargets`, `NATIONS`, `NATION_IDS`, `ROSTERS`,
  `NATION_BUILDINGS` (noms et rôles des genres partagés par nation), `ROLES`, `ZENITH`, `POWERS.sonde/curie/gaz/pression`,
  `POWER_SETS`, `POD_CREWS`.
- `rules.ts` : `Rules.nations`, `nationOf()`, `kindNation()`, `inRoster()`, `rosterBan()` (appelé en tête de
  `bannedBy`), `matchNations()`, `parseNations()`, `applyMutators(w, ids, nations)`.
- `setup.ts` / `maps.ts` : `MatchSetup.nations`, `MatchOptions.nations`.
- `lexicon.ts` : genre et pluriel de chaque nouveau nom, `NATION_NAMES`, `displayName(kind, nation)`, `grammarOf`,
  `pluralName`, paramètre `nation` optionnel sur `isFeminine/agree/theName/aName/isVerb` ; h aspiré pour
  Haut-fourneau et Hangar.
- `three/belle/placeholders.ts` (réexporté par `belle/index.ts`) : `PLACEHOLDER_MODEL`, `PLACEHOLDER_BUILDING`,
  `NATION_TEAMS`, `lookalike`, `portraitKind`, `withStandIns`.

Partie de développement : `/?nations=republique,empire` (bleu, puis rouge ; `rep,emp` accepté) sur le
serveur de dev ou le build ; escarmouche seulement (ni Survie, ni Opération, ni Défi du jour). Le tiroir de
construction ne montre que l'effectif de la nation du joueur.

Écarts au document, et pourquoi :
1. `ROLES` vit dans `balance.ts` (et `Role` dans `types.ts`), pas dans `ai/roles.ts` qui appartient à WP3 : WP3
   construit dessus.
2. Les 16 unités Classique ne portent **pas** de champ `nation` (« tout genre avec `nation` est banni en
   Classique ») : leur répartition est la table `ROSTERS`, qui couvre aussi les bâtiments (Rép sans Hotchkiss,
   Emp sans Ruggieri).
3. `NATIONS` est typé par une interface plutôt que `as const`, pour rester modifiable par `--tune` ; il gagne
   `name`/`short` (« la République », « l'Empire de Carbonie ») pour les messages « Réservé à … ».
4. `POD_CREWS` n'a d'équipage que pour la République (l'Empire n'a pas d'Obus-capsule dans `POWER_SETS`).
5. Pas encore de changement de comportement : départ (`harvester` + `trooper` pour les deux nations), ouvertures,
   IA, multiplicateurs, mécaniques et pouvoirs nouveaux sont à WP1–WP3. Une République ne peut donc pas encore
   produire de récolteur (le Fourgon n'a pas son comportement `base` avant `behaves()`), et l'IA ne joue que les
   genres de son effectif que `bannedBy` lui laisse.
6. Listes des mutateurs (`GROUND_COMBAT`, `NO_GROUND_COMBAT`, `INFANTRY_SQUADS`, `NO_VEHICLES`) : étendues à la
   main avec les nouveaux genres (Classique en tête, inchangé), pas encore calculées depuis `ROLES`. Le conflit
   Nomades/Armada ↔ République n'est pas encore imposé.
7. Duel sonore : `TABLES_COMPLETE` du codec ne vérifie que les genres Classique (les duels restent Classique
   jusqu'à `LOBBY_PROTO = 2`, WP7) ; `tests/versus-codec.test.ts` ajusté en conséquence.
8. Voix : `voice-lines.ts` n'énumère que les genres et pouvoirs Classique (les clips des nations sont WP5g).
   Le briefing de l'arène (`unitTable`/`buildingTable`) reste Classique (WP4).
9. Modèles provisoires : couleur de nation = `NATION_TEAMS[nation][camp]` (siège bleu : couleur propre ; siège
   rouge : la variante « miroir » du §1.1, dans tous les cas) ; les escouades gardent la couleur du camp (le gréement
   d'infanterie choisit ses couleurs par camp). Portraits, voix et tables par genre (`withStandIns`) : ceux du
   modèle provisoire. Les fx `arc-shell` et `heavy-shell` sont dessinés comme `shell` (`GameScene`).
10. Le Zénith est rangé dans l'onglet Véhicules à côté du Gargantua (unités du gantry, comme `TAB_OF`).
11. Pluriels choisis : « Jamais-Contente » invariable (nom propre de la voiture), « Vulcains », « Zéniths », « Titans ».
12. `tests/goliath.test.ts` « le Gargantua voit plus loin que toute autre unité » restreint aux unités Classique
    (le Zénith voit à 11).

### 3.6 WP1 — fait

Livré sur `feat/camps-wp1`. Classique inchangé bit pour bit (`tests/classic-hash.test.ts` vert) ; tests des
mécaniques : `tests/nations.test.ts` (25 tests : chaque mécanique, chaque pouvoir, déterminisme, miroirs Rép-Rép et
Emp-Emp).

Où trouver quoi :
- `src/sim/nations.ts` (nouveau) : `behaves(kind, base)` / `buildingBehaves`, `nationKind(w, f, kind)` (genre Classique →
  genre de la nation pour le même rôle), multiplicateurs (`buildingCostFor`, `buildingTicks`, `buildingMaxHp(w, b)`,
  `unitTicks`, `parallelOf`, `radiumValue`, `harvestRate`, `holdOf`), Réseau électrique (`powerSources`, `inPowerRange`,
  `needsPower`, `onGrid`, `isUnpowered`), Réseau TSF (`tsfSources`, `speedMult`, `sightBonus`), Tranchées
  (`trenchCover`), zones de pouvoirs (`revealedTo`, `veiled`), `tickNations` (appelé par `sim.ts`) et `nationStart`
  (appelé par `maps.ts`).
- État exposé au rendu et à l'UI (champs simples, absents en Classique) : `Building.unpowered`, `Unit.entrenched`,
  `Unit.still`, `Unit.tsf` (aura), `Unit.overdrive` (tick de fin de la Pression), `World.nation.reveals` (ballons-sondes,
  publics) et `World.nation.clouds` (nuages de gaz, publics). `worldHash` ne les couvre que si `World.nation` existe.
- `powers.ts` : `powerSet(w, f)` (les quatre pouvoirs du camp), Ballon-sonde, Gaz de houille, Pression, Rayon Curie
  (`landHammer` paramétré), `podCrew` par nation (`POD_CREWS`).

Écarts au document, et pourquoi :
1. Les nouveaux champs d'état sont déclarés depuis `nations.ts` par augmentation de module (`declare module "./types"`)
   au lieu d'être écrits dans `types.ts` (registre de WP0, gelé) : mêmes champs, visibles partout.
2. Pas de `FxEvent` nouveaux (« hors réseau », « retranchée ») : l'union est dans `types.ts` ; le rendu lit les drapeaux.
   La surchauffe de la Pression émet l'événement `stun` existant.
3. Les tests de genre du Gargantua (`kind === "goliath"`, `spawnUnit` qui crée `GoliathState`, Zénith) restent à WP2
   (`goliath.ts`, `lift.ts`) ; `nations.ts` compte déjà un Zénith (`kind === "zenith"`, amarré : `goliath.mode ===
   "anchored"`) comme source des deux réseaux. Levage par deux Titans : `lift.ts` (WP2) ; le transport d'escouades du
   Titan (capacité 3) marche déjà par `UNITS.capacity`.
4. Tranchées : « immobile » = pas d'ordre `move/attackMove/board` et pas déplacée de plus de 0,02 case depuis le tick
   précédent ; près d'une Hotchkiss, l'escouade immobile est retranchée dès le tick suivant.
5. Gaz : le seuil d'acquisition est `POWERS.gaz.acquire` = 2 cases (le test vérifie bloqué à 2,5, pas à 1,5) ; il filtre
   l'acquisition automatique (unités et défenses) et fait lâcher une cible auto entrée dans le nuage, pas un ordre
   d'attaque explicite. Le nuage masque aussi sous Ciel dégagé.
6. Ballon-sonde : peut viser une zone inexplorée (c'est son rôle) ; les autres pouvoirs gardent la règle.
7. Pression : tous les véhicules terrestres non-infanterie du camp dans le rayon (Gargantua compris).
8. Coûts de bâtiments par nation arrondis à l'entier (Tour TSF républicaine : 128) ; PV max arrondis.
9. Réseau électrique : un bâtiment dans l'anneau d'un Gargantua/Zénith amarré reste plaçable (règle d'avant-poste) ;
   `placementBlocker` dit « Hors du réseau électrique » ; `suggestPlacement` cherche aussi autour des sources.
10. Fichiers hors liste touchés au minimum pour `behaves()`/`nationKind()` : `sim.ts` (commande `harvest`, appel de
    `tickNations`), `maps.ts` (`nationStart`, unités de départ de la carte et d'Aéroportés par nation), `rules.ts`
    (`nationBansMutator` : Nomades/Armada retirés si la République joue), `openers.ts` (Fourgons et unités d'ouverture
    de la nation), `lifeline.ts` (Titan/Fusiliers pour l'Empire), `objectives.ts` et `salvage.ts` (récolteurs),
    `tests/salvage.test.ts` (le Fourgon ne laisse pas d'épave, comme le Fardier).
11. Reste aux autres lots (sites qui lisent encore `kind === "harvester"` ou `BUILDINGS[k].hp`) : WP6 —
    `game/controller.ts` (ordre de récolte au clic, `isArmyUnit`), `GameScene.ts` (récolteur de départ du joueur mis au
    travail), `render/entities.ts` (barres de vie : utiliser `buildingMaxHp`), `ui/hud.ts`/`controller.ts` (prix de
    revente), `awareness.ts`, `chronicle.ts`, textes d'ouverture (« Fardiers ») ; WP3 — `ai/*` (`ai/menders.ts` PV
    des bâtiments, placement sous réseau via `inPowerRange`/`powerSources`), `modes/survival.ts` ; WP4 — `arena/observe.ts`.

### 3.7 WP2 — fait

Zénith livré **avec amarrage** (le repli « Zénith sans amarrage » n'a pas servi). Classique et Empire inchangés :
`tests/classic-hash.test.ts` et les 7 fichiers de tests du Gargantua passent tels quels. Tests : `tests/zenith.test.ts` (13).

Où trouver quoi (`src/sim/goliath.ts`) :
- `SUPER[kind]` (`goliath`, `zenith`) : `tune` (GOLIATH ou ZENITH, lus en direct, donc `--tune` les atteint),
  `weapon(slot)`, `weaponId(slot)`, `trains(kind)`, `repairedBy`, `liftable`, `words` (libellés ancré/amarré).
  `superOf`, `isSuperKind`, `superTune`, `superKindOf(w, camp)` (= `ROLES[nation].super`, Gargantua en Classique),
  `weaponStats(u, slot)`, `ensureSuper`, `spawnSuper`, `canRepair(healer, cible)`, `trainableBy(w, g, kind)`,
  `superView(u)` (champs simples pour le rendu : mode, progression d'amarrage, amarré, armes avec id/état/firedTick).
- Les armes du Zénith occupent les 4 emplacements du Gargantua (`ZENITH_SLOTS` : mortars → branly, laser → arc,
  cannons → bombs, mg → mg ; mêmes seuils 0,75 / 0,5 / 0,25 / jamais) : `GoliathState`, les fx `goliathWeapon`
  et `types.ts` ne changent pas. Le rendu traduit l'emplacement par `SUPER.zenith.weaponId(slot)`.
- Amarrage = le mode « anchored » du Gargantua, avec les temps de ZENITH (3 s / 4 s), sur un 2×2 constructible
  libre (le mât est inscrit dans `World.occupancy`). Amarré : point de dépôt (`nearestDropSite`, sans changement),
  anneau de construction, production d'Éole, Blériot, Pasteur et Patrie (`trainableAt` tient compte de la nation ;
  le Classique garde l'ancienne expression mot pour mot). Jamais levé (`lift.ts liftBlocker` → « Il vole déjà »).
- Coût +25 % par Zénith possédé (`goliathCost(w, camp, kind)`, compte par genre). Nomades / Armada avec nations :
  le super de la nation (un Zénith d'Armada vole seul, sans Montgolfières).
- IA (`ai/goliath.ts`) : même plan pour le Zénith — il vole (pas de levage, tout site accessible, relais
  d'îles compris ; un champ coupé de la base par le sol vaut ×0,7), s'amarre comme le Gargantua s'ancre, et
  amarré produit des aéronefs (`hangarPick` : Pasteur s'il est blessé sans Pasteur près de lui, Blériot face à
  l'aviation, sinon Éole). `wantGantry` teste le bannissement du super de la nation.

Crochets attendus des autres lots (non modifiés ici, propriété WP1/WP3) :
1. `combat.ts goliathWeapons` : `const st = GOLIATH.weapons[k]` → `weaponStats(u, k)` (sinon le Zénith tire avec les
   armes du Gargantua ; seuils, portées d'ordre, `goliathReachAt` et la menace IA sont déjà les bonnes).
2. `combat.ts tickHealer` : ignorer une cible si `!canRepair(u.kind, o)` (Pasteur seul pour le Zénith ; l'Atelier,
   `healTargets: "ground"`, l'exclut aussi une fois `healTargets` en place).
3. `world.ts spawnUnit` : `isSuperKind(kind)` (ou `behaves(kind, "goliath")`) au lieu de `kind === "goliath"` pour créer
   `unit.goliath` (en attendant, `tickGoliaths` le crée au tick même de la sortie du Hangar, et `spawnSuper` aussi).
4. `economy.ts` : `trainBlocker` → `trainableBy(w, g, kind)` ; `queueCap` → `isSuperKind(kind) ? superTune(kind).queueMax` ;
   `goliathBuildNews` / `GOLIATH.nearlyDone` → `isSuperKind(head.kind)` / `superTune` ; le bannissement du gantry
   (« banni avec le Gargantua ») → `superKindOf(w, camp)` (aujourd'hui le Hangar du Zénith est banni pour la République) ;
   message « Ancre-le pour produire » → `superOf(g.kind).words.trainHint`.
5. `salvage.ts` : `UNITS.goliath.cost/buildTime` → `UNITS[kind]` ; `powers.ts` : le texte « GQG ou un Gargantua ».
6. WP1 Réseau électrique / TSF : un Zénith amarré (`isAnchored(u) && u.kind === "zenith"`) est une source ; tout
   Zénith pour le TSF.
7. WP3 `ai/commander.ts` : produire `superKindOf(w, camp)` au Gantry (`unit: "goliath"` en dur l. 473), compter
   `unitCost(w, f, superKindOf(...))`.

### 3.8 WP3 — fait

Livré sur `feat/camps-wp3`. Classique vérifié : `classic-hash.test.ts` vert, et 39 configurations IA-contre-IA
de 7 min (6 cartes × 6 personnalités, 3 difficultés, mutateurs, ouvertures, objectifs, Survie) produisent les
mêmes hachages et les mêmes commandes avant/après.

Où trouver quoi :
- `ai/roles.ts` : `aiKinds(nation)` (les emplacements que remplit le commandant, dérivés de `ROLES` ; la ligne
  `classique` redonne exactement les genres d'avant), `behaves()`/`baseOf()` locaux à l'IA, `buildingFor()`
  (Rép : `turret` → `arsonval` ; Emp : `sam-site` → `flak-battery`), `isDefence`, réseau électrique vu par
  l'IA (`needsPower`, `powerSources`, `poweredAt`, `unpoweredBuildings`).
- `ai/commander.ts` : production par rôle (Forges/Parc/Manufacture : l'Estafette et l'Atelier sortent des Forges),
  `NATION_STRATEGIES` (`siege`, `volta`), `PERSONALITIES`, `NATION_POOLS`/`poolFor()`, re-tirage dans la
  réserve de la nation au premier passage quand la personnalité était tirée au hasard ; placement sous réseau
  (rayons des sources d'abord, sinon une Tour TSF ancrée vers le bâtiment voulu, plafond 6 ; Tour reconstruite
  près d'un bâtiment éteint ; Station de charge précédée d'une Tour vers son gisement) ; Fourgons envoyés
  d'abord sur le radium à ≤ 20 cases ; guetteur du Mortier de 280 (`planSpotter` : le premier éclaireur se
  tient à 6,5 cases de la cible des pièces) ; super-unité = `ROLES.super` à la Galerie/au Hangar ;
  compteurs `waves`/`firstWaveTick` dans `AiState`.
- `ai/powers.ts` : pouvoirs filtrés par `POWER_SETS` ; Rayon Curie (règle de l'Obus Méliès, amas ≥ 800) ;
  Pression (≥ 4 véhicules dans le rayon, vague lancée ou au contact) ; Gaz (colonne ≥ 400 à ≤ 6 cases de
  ≥ 2 défenses connues, en assaut) ; Ballon-sonde (tir reçu sans tireur visible, sinon toutes les 90 s sur le
  QG ennemi). Un pouvoir de nation que la sim n'accepte pas (compteur `fired` inchangé) est écarté.
- `ai/condor.ts`, `ai/airlift.ts`, `ai/menders.ts` : tests de genre remplacés par comportement (transport,
  tireur d'élite, récolteur, réparateur ; l'Atelier roulant ne suit que les unités au sol).
- `modes/survival.ts` : vagues par rôle (chaque genre Classique des réserves vaut pour son rôle chez la nation
  attaquante ; l'artillerie impériale amène des Mortiers de 280 dès la vague 6).
- `tests/ai-nations.test.ts`.

Écarts, et pourquoi :
1. `siege`/`volta` ne sont pas dans `STRATEGIES`/`StrategyName` (les outils, le Défi du jour et les tables par
   personnalité de `ai/goliath.ts` itèrent ces clés : le Défi du jour aurait changé) mais dans
   `NATION_STRATEGIES` ; leur `name` est la personnalité Classique dont elles empruntent les tables (`siege` →
   `ironclad`, `volta` → `rush`), leur `id` la leur ; `personalityOf(s)` rend le vrai nom.
2. Les six personnalités Classique jouent les deux nations quand on les demande ; seules les réserves au hasard
   suivent le tableau du §1.9.
3. Sans le `behaves()` de WP1 la sim ne fait récolter que le genre `harvester` : l'IA détecte un genre de
   récolteur qui reste inactif après un ordre de récolte et cesse d'en construire. Le test donne alors trois
   Fardiers de remplacement à chaque camp (il le détecte et s'en passe une fois WP1 fusionné).
4. Le Gargantua/Zénith : `wantGantry`/`wantGoliath` (fichier de WP2) refusent tant que `goliath` est banni,
   donc la République ne construit pas encore de Hangar ; la commande produit déjà `ROLES.super`.
5. Ouvertures (`openers.ts`) non adaptées : leurs genres Classique sont bannis en partie « nation », donc pas
   d'ouverture pour l'IA en nation. Boss de Survie : pas de Gargantua (vague de cœur par rôle seulement).

Mesures (sans les mécaniques de WP1, Fardiers de remplacement) : Rép contre Emp, 20 parties sur 5 cartes,
chaque nation de chaque côté : Empire 18, République 1, nulle 1 (médiane 9,8 min) — non significatif tant que
la Rép ne peut pas remplacer ses récolteurs ni profiter de ses multiplicateurs ; miroirs (12 parties chacun) :
Emp-Emp bleu 6 / rouge 6 (médiane 12,9 min), Rép-Rép 5 / 7 (11,3 min), aucune nulle. À remesurer par WP4.

### 3.9 Intégration — fait

Sur `feat/camps` : fusion de `feat/camps-m-bat` (WP5f/WP5d) avec les branches de modèles déjà fusionnées, puis les
crochets entre lots. Classique inchangé bit pour bit (`classic-hash.test.ts` vert) ; suite complète, build et
`tools/smoke.mjs 390 844` verts.

Fusion des modèles :
- `belle/index.ts` enregistre tout : `GROUND_REP`, `GROUND_EMP`, `AIR_EMP`, `zenith`, les escouades (`nationSquadDef`),
  `BE_NATION_BUILDING_MODELS` (bâtiments de nation) et `BE_LANDMARKS` (Tour Eiffel).
- `placeholders.ts` : `STAND_IN` / `STAND_IN_BUILDING` complets (voix, portraits, tables `withStandIns`) ;
  `PLACEHOLDER_MODEL` et `PLACEHOLDER_BUILDING` vides (liste `MODELLED` des 15 genres) ; `lookalike(k)` = ce que dessine
  le rendu (le genre lui-même désormais).
- Couleurs unifiées dans `models.ts` : `unitDef(kind, f, owner?)` et `buildingDef(kind, f, owner?)` peignent tout modèle
  d'une armée de nation — genre propre **ou partagé** (GQG, Forges, Panhard d'un Empire…) — en `NATION_TEAMS[nation][camp]`
  (le crochet `inNation` de `ground-rep.ts` est supprimé). `SquadRig(kind, f, seed, alive, nation)` fait de même pour les
  escouades partagées. `?style=original` dessine aussi les modèles et escouades des nations (ils n'existent qu'en Belle Époque).

Crochets câblés : les 7 de WP2 (§3.7 : `weaponStats`, `canRepair`, `spawnUnit`, `trainableBy`/`queueCap`/annonces/
bannissement du Hangar par `superKindOf`/`trainHint`, `salvage.ts`, texte de `powers.ts` ; le Zénith amarré était déjà
source chez WP1 ; `ai/commander.ts` produisait déjà `K.super` au prix `unitCost`). IA : la sonde « récolteur inerte » de
WP3 ne marque plus aucun récolteur (le Fourgon récolte), menace antiaérienne du Zénith par ses armes, `behaves()` dans
`ai/salvage`, `veterans`, `objectives`, `goliath`, `powers`. Ouvertures : `openerBlocked` traduit les genres par rôle
(`nationKind`) : l'IA et le joueur ont leurs cartes d'ouverture en nation. Interface (handoffs WP1 §3.6 n° 11) : récolteur
de départ, ordres de récolte, revente, PV par `behaves`/`buildingMaxHp`/`buildingCostFor` ; textes au nom du récolteur
de la nation (« leurs Fardiers » = ceux de l'ennemi) ; libellés d'amarrage ; annonces du Zénith reformulées
(`callouts.ts zenithLine` : « Zénith ennemi en amarrage »…, sans clip enregistré, sous-titrées).
Rendu : `ZenithView` branché avant le Gargantua et nourri par `superView` ; Hangar par `isSuperKind` ; sacs de sable
(`entrenched`) ; variante de matériau `unpowered` + éclair barré clignotant ; arc de la Bobine éteint hors réseau ;
vapeur de la Pression ; visuels du Ballon-sonde, Gaz de houille, Rayon Curie et Pression (`render/powers.ts`).
Correctif : `MUSIC.strikeBoost` manquait les quatre pouvoirs de nation (NaN dans la musique, erreurs console).

Escarmouche : contrôle « Nation » (Classique / République / Empire) dans le menu Belle Époque, réglage `nation` de
`battledrones.settings` ; l'IA prend la nation adverse ; `?nations=` reste prioritaire ; ni Survie, ni Opération, ni
Défi du jour, ni duel.

Mesure rapide (avant WP4, aucun nombre retouché) : Rép contre Emp, IA Normal, 6 cartes × 2 sièges × 4 couples de
personnalités (balanced/balanced, volta/siege, skyforce/ironclad, airswarm/boom) = 48 parties, plafond 25 min :
**Empire 42, République 5, nulle 1** ; médiane 11,1 min. Par carte (Rép–Emp) : Terrain d'essai 2–6, Terres fluviales 1–7,
Mer de dunes 2–5 (+1 nulle), Engelure 0–8, Cendres 0–8, Archipel 0–8. Siège bleu/rouge de la Rép : 2–21 / 3–21. Le Hangar
du Zénith est bâti dans 28 parties, un Zénith ne sort que dans 5 (le fonds de l'IA n'atteint pas 1 500), contre un
Gargantua dans 38. Pas de bogue trouvé derrière : récolte par travailleur comparable (5 min, un seul : Fourgon 2 880,
Fardier 3 100), aucun blocage de production. C'est le chantier de WP4.

Restes : `unit-info.ts`/`arena/observe.ts` Classique, conseiller (`advisor.ts`) qui ne reconnaît que la Patrie comme
éclaireur.

### 3.10 WP4 — Mesures

Branche `feat/camps-bal`. Classique inchangé bit pour bit (`tests/classic-hash.test.ts` vert) : tous les leviers d'IA
ajoutés ne s'appliquent qu'à un camp qui joue une nation (`nation !== "classique"`), et les seuls nombres touchés dans
`balance.ts` sont ceux des nations et de leurs unités propres.

**Outils** (tous en Node, déterministes : même commande → mêmes lignes ; ~0,33 s de calcul par minute simulée)
- `npx vite-node tools/pacing.ts run out.jsonl --nations rep-emp|rep-rep|emp-emp [--seeds N] [--jobs N]` : panel IA contre
  IA. `rep-emp` joue chaque personnalité de la réserve Normal de la République (balanced, rush, airswarm, skyforce,
  volta) contre chaque personnalité impériale (balanced, rush, airswarm, boom, ironclad, siege), la République de chaque
  côté, sur les 6 cartes : 360 parties par graine ; les miroirs jouent chaque couple ordonné de la réserve (150 / 216).
  Ouvertures et objectifs (Liaisons, largages) comme en escarmouche ; `--bare` (ni l'un ni l'autre), `--no-openers`,
  `--no-objectives`, `--pairs a/b,…`, `--cap <min>`, `--tune JSON` (atteint aussi `NATION_AI`, `OBJECTIVE_AI`,
  `NATION_STRATEGIES`, `GOLIATH_AI.nation`). `--jobs N` lance N processus (défaut : un par cœur) et réunit leurs
  fichiers : 720 parties en ~6 min sur 10 cœurs.
- `pacing.ts summary --nations <fichiers>` : part de la République (intervalles de Wilson à 95 %), par carte, par siège,
  par personnalité, par couple ; part du rouge dans les miroirs ; courbes médianes par nation (valeur d'armée, récolte,
  récolteurs, bâtiments, banque à 2, 4, 6… 15 min) ; super-unité (part des camps qui en alignent une, heure médiane,
  Hangar/Galerie) ; première vague ; part du radium ; secondes de bâtiments éteints ; pouvoirs ; **tableau par genre**
  (construits, dépensé, pertes, valeur d'unités et de bâtiments tués par coup de grâce, tués / valeur perdue) ; qui menait
  l'armée à 6:00. Chaque ligne du `.jsonl` garde ces mesures (`Match.nat`, `tools/pacing-match.ts`).
- `tools/balance.ts duels --nations [--trench] [--tsf]` (matrice 10 × 11 à 1 800 de charbon, sous les règles des
  nations, moyenne par unité), `goliath --vs zenith [--menders N]` (super contre super, et chacune contre des groupes de
  coût égal de l'autre nation), `siege` (groupes de siège contre 3 Hotchkiss + Batterie de 47, ou 2 Bobines + Ruggieri +
  Tour TSF : temps pour raser, pertes).
- `tools/arena.ts … --nations rep,emp` : arène en nations (le record garde `nations` et se rejoue) ; sièges `ai:siege`,
  `ai:volta`.

**Ce qui faisait perdre — ou gagner — la République** (panel de départ : 360 parties, code de `feat/camps`)
1. *La première lecture mesurait un départ nu.* Sans ouvertures ni objectifs (ce que faisait le script de §3.9),
   l'Empire gagne 75 % [70–79] ; **en escarmouche réelle** (ouvertures + Liaisons + largages, comme le jeu et l'arène) la
   République gagnait 60 % [54–65]. Ce sont les objectifs qui renversent tout (sans ouvertures mais avec objectifs : Rép
   64 % ; sans objectifs mais avec ouvertures : 26 %) : l'IA impériale envoyait ses escouades lentes (400 de charbon, et
   aussitôt une autre si la première mourait) prendre des Liaisons au milieu de la carte, où l'armée rapide de la
   République les mangeait une à une. Résultat : à 4:00, armée Rép 3 964 contre 1 953 ; 83 % des parties de moins de
   8 min à la République, 40 % des plus longues.
2. *Vapeur gaspillée (bogue d'IA).* Les usines impériales fabriquent 2 éléments de file à la fois, mais l'IA ne gardait
   qu'un élément en file sous 700 de charbon : chaque usine tournait à 1/1,3 du débit Classique au lieu de ×1,54.
3. *Bogues de genre dans l'IA.* `ai/objectives.ts` excluait des Liaisons le Pasteur, le Canon de 75, la Patrie et les
   chasseurs alpins par leur genre : l'Atelier roulant, le Mortier de 280 (vitesse 0,9), le Canon Branly, l'Estafette et
   les carabiniers partaient prendre et garder des Liaisons. Le Gargantua formait des « pioupious » (genre interdit à
   l'Empire : rien), les chasses et escortes de super-unités comptaient l'Atelier (sans arme) comme combattant, la
   caisse « unité » des largages donnait un Hydroglisseur à l'Empire.
4. *Économie.* Récolte par travailleur comparable, mais la République aligne 5 Fourgons contre 4 Fardiers : récolte à
   4:00, 12 000 contre 8 300 ; le radium ×1,5 creusait l'écart sur les cartes qui en ont (Terres fluviales 87 %).
5. *Zénith rare.* Les personnalités républicaines bâtissent le Hangar tard (rush, airswarm, skyforce : 420–480 s) et
   n'épargnent que 35 % : Zénith dans 26 % des camps contre Gargantua dans 38 % (sur départ nu : 11 % contre 49 %).
6. *Tranchées ×0,7.* Sur l'Archipel, les Fusiliers retranchés tiennent les Liaisons d'île contre les pioupious :
   14 % pour la République, beaucoup de nulles.
Le réseau électrique ne freine pas l'IA : 14–50 secondes-bâtiment éteintes par partie, et le Garage/Parc/Manufacture
sortent plus tôt que chez l'Empire (Manufacture 0:28 contre 1:16).

**Changements**
| Où | Avant | Après | Pourquoi |
|---|---|---|---|
| `ai/commander.ts` profondeur de file | 1 (2 au-dessus de 700) | ≥ `parallel` (Empire : 2) | point 2 |
| `ai/objectives.ts` `OBJECTIVE_AI.empire` | toute Liaison, escouade 400, renvoi immédiat | Liaisons de sa moitié (`reach` 0,5), escouade 600, 45 s avant de renvoyer après une perte | point 1 (60 % → 55 %) |
| `ai/roles.ts` `isGun`, `noObjectiveDuty` ; `ai/objectives.ts`, `ai/goliath.ts`, `ai/veterans.ts` | tests de genre Classique | par comportement (réparateur, canon à portée minimale, éclaireur, tireur d'élite) | point 3 |
| `ai/goliath.ts` escouades du Gargantua | `trooper`/`rocket-squad` | `ROLES[nation].line/at` (Fusiliers) | point 3 |
| `sim/objectives.ts` caisse « unité » | Hydroglisseur pour tous | `nationKind` (Empire : Creusot) | point 3 |
| `ai/commander.ts` `NATION_AI.empire.workers` | 0 | +1 Fardier | point 4 (45 %, parties courtes 49/102 au lieu de 72/97) |
| `NATIONS.republique.radiumValue` | 2,4 | **2,0** (×1,25) | point 4 (Terres fluviales) |
| `ai/goliath.ts` `GOLIATH_AI.nation.republique` | — | Hangar à 0,75 × l'heure, épargne +10 points | point 5 |
| `NATIONS.empire.trench.mult` | 0,7 | **0,9** | point 6 (Archipel sans tranchées : 46 %) |
| Canon Branly PV | 170 | **200** | 0,44 tué par valeur perdue, le pire de la République |
| Autocanon De Dion PV | 230 | **260** | perdait contre des Vulcains à coût égal (−0,26 → −0,09) |
Leviers essayés et écartés : `coalRate` 1,4 (37 %, Archipel 2 %), Rép `unitTime` 1,0 (45 %, siège bleu 39 %),
garde économique impériale ×1,6 (Archipel 17 %, 42 nulles), Hotchkiss en tête d'ordre de construction (`redoubt`, sans
effet mesurable), Titan à 2 escouades (sans effet : l'IA charge `UNITS.condor.capacity`, voir restes).

**Résultat final** (Normal, 25 min, ouvertures et objectifs ; Wilson 95 %)
| Mesure | Avant (360 parties) | Après (720 parties) | Cible |
|---|---|---|---|
| Rép contre Emp, part de la République | 60 % [54–65] | **51 % [47–55]** (n = 636 décidées) | 45–55 % |
| Terrain d'essai | 66 % [53–76] | 46 % [37–55] | 40–60 % |
| Terres fluviales | 87 % [76–93] | **65 % [55–73]** | 40–60 % ✗ |
| Mer de dunes | 71 % [58–81] | 40 % [32–50] | 40–60 % |
| Engelure | 53 % [41–65] | 58 % [49–66] | 40–60 % |
| Cendres | 61 % [48–72] | 54 % [45–63] | 40–60 % |
| Archipel | 14 % [7–26] | **34 % [23–47]**, 61 nulles sur 120 | 40–60 % ✗ |
| Siège de la Rép bleu / rouge | 63 % / 57 % | 54 % [48–59] / 48 % [43–54] | équitable |
| Miroir Rép-Rép, part du rouge | — | 57 % [51–63] (n = 283 ; 300 parties) | 45–55 % (Classique `--mirror` : 53 %, n = 209) |
| Miroir Emp-Emp, part du rouge | — | **50 % [45–55]** (n = 377 ; 432 parties) | 45–55 % |
| Super-unité alignée (camps) | Zénith 26 %, Gargantua 38 % | **Zénith 48 % (7:23), Gargantua 42 % (7:58)** | comparable |
| Durée médiane | 11:18 | **11:15** | 9–15 min |
| Nulles (25:00) | 4 % | 12 % (dont 61 sur l'Archipel) | < 8 % ✗ |
| Armée à 6:00 (médianes Rép / Emp) | 3 395 / 1 823 | 2 769 / 2 377 | — |
| Récolte à 4:00 (médianes Rép / Emp) | 12 000 / 8 300 | 11 600 / 9 700 | — |
| Parties < 8 min / > 16 min gagnées par la Rép | 74 % / 49 % | 55 % / 47 % | — |
| Départ nu (`--bare`, 360 parties), pour mémoire | 25 % [21–30] | 16 % [13–21] | hors jeu (l'escarmouche a toujours ses objectifs) |

Personnalités (part de victoires contre toute la réserve adverse) : Rép balanced 85 %, airswarm 62 %, skyforce 39 %,
volta 39 %, rush 29 % ; Emp siege 69 %, balanced 56 %, boom 54 %, rush 51 %, ironclad 35 %, airswarm 31 %. Rép rush,
Emp airswarm et ironclad sont sous la barre des 35 % du §1.8.

**Efficacité par genre en partie** (720 parties ; « tués/perdu » = valeur d'unités ennemies achevées ÷ valeur perdue ;
le coup de grâce seul est compté, ce qui favorise les tirs lourds et défavorise ce qui affaiblit sans achever)
| République | dépensé/partie | tués/perdu | | Empire | dépensé/partie | tués/perdu |
|---|---|---|---|---|---|---|
| Éole | 6 260 | 0,57 | | Épervier | 3 936 | 0,71 |
| Jamais-Contente | 4 050 | 1,04 | | Gyroptère | 3 541 | 0,42 |
| Blériot | 3 191 | 1,08 | | Panhard | 3 345 | 1,05 |
| Pioupious | 2 890 | 0,79 | | Canon de 75 | 2 041 | 0,60 |
| Canon Branly | 2 483 | 0,44 | | Fusiliers | 2 024 | 0,80 |
| Albatros | 2 111 | 0,33 | | Artificiers | 1 893 | 1,29 |
| Hydroglisseur | 1 818 | 1,19 | | Faucheux | 1 738 | 1,89 |
| Sapeurs-électriciens | 1 431 | 0,70 | | Mortier de 280 | 1 226 | 0,70 |
| De Dion | 1 414 | 1,28 | | Gargantua | 1 047 | 4,69 |
| Zénith | 1 160 | 4,70 | | Creusot | 871 | 0,66 |
| Chasseurs alpins | 444 | 2,18 | | Vulcain | 711 | 0,33 |
| | | | | Carabiniers | 564 | 1,94 |
Aucune unité ne domine (les super-unités sont à part : 1 par camp au plus, perdues dans moins de 20 % des cas) ; les
bombardiers (Albatros, Vulcain, 0,33) et les aéronefs d'attaque sont faibles des deux côtés, à parts égales — c'est
l'IA qui les jette contre la DCA. Duels à coût égal (`duels --nations`) : moyenne des lignes −0,35 (De Dion, qui ne tire
qu'en l'air) à +0,29 (Albatros) ; colonnes −0,24 (Mortier de 280) à +0,29 (Vulcain) ; toile du §1.5 : Jamais-Contente
contre Creusot +0,58 (cible +0,25–0,45), Panhard contre Jamais-Contente +0,14 (cible +0,2–0,4), Fusiliers contre
Jamais-Contente +0,46, Sapeurs contre Creusot +0,69, carabiniers contre pioupious +0,54, chasseurs alpins contre Fusiliers
+0,73, De Dion contre Gyroptère +0,66. Zénith contre Gargantua seul à seul : **+0,71 pour le Zénith** (cible 45–55 %) —
le Gargantua n'a contre l'air que son arc et ses mitrailleuses (~33 DPS effectifs) et ses armes sont Classique ; baisser
l'arc du Zénith de 26 à 16 DPS ne ramène qu'à +0,54 et l'affaiblirait contre tout le reste. Le Zénith perd nettement
contre Faucheux, Épervier et Artificiers de coût égal : son contre est l'escorte antiaérienne, pas le Gargantua. Siège :
les défenses républicaines (2 Bobines + Ruggieri + Tour TSF) tombent sans pertes devant Mortier de 280, Canon de 75 et
Creusot ; les impériales coûtent 60–100 % de leur valeur aux groupes républicains sauf au Canon Branly (portée 8,5).

**Restes**
- Terres fluviales (65 %) : l'Empire y perd 13 Fardiers par 10 minutes (10–12 ailleurs) sous les raids des
  Jamais-Contente et des Éole ; aucun levier global ne l'a ramenée sous 60 % sans faire tomber une autre carte.
- Archipel : moitié de nulles (Classique : 8 %). Sans super-unités les nulles tombent de moitié : un Zénith qui vole ou un
  Gargantua planté sur une île survit au QG, et aucune IA ne sait l'achever. À traiter dans `ai/goliath.ts` (chasse d'un
  Zénith par Éperviers et Faucheux) plutôt que par des nombres.
- Miroir Rép-Rép : 57 % au rouge (Classique `--mirror` 53 %, mêmes cartes) ; à suivre avec plus de graines.
- L'IA du Titan charge `UNITS.condor.capacity` (2) au lieu de 3 (`ai/airlift.ts`, `ai/condor.ts`) et le levage par deux
  Titans n'est jamais tenté (`canLift` teste la Montgolfière) ; corriger avantagera l'Empire sur l'Archipel.
- Duel Zénith–Gargantua hors cible (ci-dessus) ; personnalités Rép rush, Emp airswarm/ironclad sous 35 %.

### 3.11 WP5g — Art — fait

Branche `feat/camps-art`. Les 7 véhicules terrestres et les 4 aéronefs de l'Empire repris au niveau de détail des
premiers modèles Belle Époque (1 900 à 3 250 triangles ; plafonds des tests 3 300 au sol, 3 000 en l'air) ; Vulcain
(cigare court, dos d'équipe coupé de bandes de fer, 2 moteurs, queue cruciforme) et Titan (long ballon tout d'équipe,
4 moteurs, double dérive) distincts vus de dessus. Portraits de toutes les unités et de tous les bâtiments des nations,
bleu et rouge (`model-portraits.mjs --nations` ; bâtiment partagé dessiné par la nation : `hq@empire` → `hq-empire.webp`,
`portraitKind(kind, nation)`), dans le tiroir, les fiches et les cartes d'ouverture. Voix : 206 répliques nouvelles
(unités, bâtiments sous leur nom de nation, pouvoirs, Citadelle, Zénith) ; « Alerte : notre Citadelle est attaquée ».
Cris d'unités propres aux 15 genres, sons `arcShell`, `heavyShell`, `arcBolt`, `flak47`, `zenithDrone` ; lueur bleue
discrète des unités relayées par le Réseau TSF.

### 3.12 WP6 et WP7 — Interface et duel en ligne — fait

Sur `feat/camps-ui`. **WP7** : `LOBBY_PROTO` 2 par une extension en fin de trame (lisible par un pair proto 1, qui
joue alors Classique), nation de l'hôte dans l'offre, choix de l'invité dans la feuille (Rép / Emp / Classique =
« la nation adverse »), nations dans `confHash` seulement hors Classique ; codec étendu (`CODEC_VERSION` 2) ;
`BattleRecord.nations` et relecture ; feuille du duel en ligne au style Belle Époque. **WP6** : sélecteur de nation
au menu (deux cartes à blason, identité, mécaniques, 3 unités, option Classique, adversaire « nation adverse /
au hasard / miroir », réglage `rival`) ; blasons générés (`art/catalog.py crest-*`, `public/assets/ui/crest-*.webp`) ;
blason dans la pastille du HUD, écran de fin avec blasons et ligne de nation ; cartes d'info en jeu par nation
(contres contre l'autre nation, règle de nation) et `unit-info.ts` complet ; « Citadelle attaquée » ; conseiller
(Estafette = éclaireur) ; rayon du Réseau électrique au placement et refus « Hors du réseau : près du GQG ou d'une
Tour TSF » ; noms de nation du placement (« Placer Garage électrique Jeantaud ») ; `models.html` filtre Nation.
Restes : page des modèles hors style Belle (portraits aux couleurs de nation : faits, §3.11 et §3.14).

### 3.13 WP8 — Campagne — fait

Livré sur `feat/camps-camp`. `src/sim/ops.ts` : `CAMPAIGN` (12 missions, anciens ids conservés) et `TRIALS` (les 8 ops
Classique, ids `-classique`, onglet « Épreuves »), `OPS` = les deux ; `OpDef.nations/act/cards/dressing/art/script` ;
but `reach` (atteint une fois, reste acquis) ; `destroy` par `tag` ; `CAMPAIGN_UNLOCKS`, `arsenalFor`, `playerBansOf`,
`unlocksAfter` ; `rules.sideBans[f].powers` (lu par `powers.ts`) et `OpRules.enemyPowerBans` ; `Building.hpMult`
(lu par `buildingMaxHp`) ; `OpsState.names/landmarks/events/tagDeaths`. Cartons : `src/ui/cine.ts` + `campaign.css`
(moteur du film d'intro, projecteur, iris ; un plan sépia par chapitre, `public/assets/ui/campaign/`, `art/campaign.py`).
Menu : onglet « 📜 Campagne » (chapitres par acte, nation, étoiles, verrous) et « 🎖 Épreuves ». Pilotes :
`tests/ops-pilots.ts`, `npx vite-node tools/ops.ts campaign 3`.

Écarts : M12 sur **Terres fluviales** (la Seine), pas le Terrain d'essai : la Tour TSF « eiffel » (1 case, PV ×4) est
dessinée par `landmarkDef("eiffel")` à l'entrée du pont ; le Colosse part de la Citadelle avec une escorte (3 Creusot,
1 Atelier) à 2:30. Habillage « polygone » : non fait (champ seulement). M7 : tunnel au nord-ouest (8, 2), route le
long du lac (les coordonnées du doc tombaient dans le lac / près de la Citadelle), 5 Hotchkiss + 3 Fusiliers.
M10 : une seule Batterie de 47 (deux abattent l'escadre fixe en Difficile). M3 : un Faucheux par ballon et une
Batterie de 47 sur l'île du centre (sinon gagné en 2 min aux Éole). M4 : garnison républicaine + revenu 30 %.
Réglages provisoires (Empire bien plus fort avant WP4) à revoir après l'équilibrage : M3 (assault 3600, revenu
70 %), M6 (gagné par une ruée à 1:30 ; trop dur dès qu'on défend la base), M9 (Difficile tenu 2/3), M11 (2/3),
M12 (combat ~2–3 min), Obus Méliès interdit à l'ennemi en M3 et M7.

### 3.14 Intégration finale — fait

Sur `feat/camps` : fusions de `feat/camps-bal`, `-art`, `-ui`, `-camp` dans cet ordre, `tsc` et `vitest` verts après
chacune. Conflits : `awareness.ts` (libellé du GQG par nation : version de l'interface, qui contient celle de l'art),
`arena/record.ts` (deux champs `nations` : un seul, partiel, celui que lit la relecture), `art/catalog.py` (blasons et
plans de chapitre gardés), ce document (notes de chaque lot en §3.10–3.13 ; restes de §3.9 repris de l'art).

**Corrections croisées**
- Voix : les 6 titres de mission nouveaux, « Mission réussie / échouée », « Ferrand l'a fini ! », « Le Colosse se met
  en marche ! » (10 répliques, `voice-lines.ts` lit à nouveau `OPS` entier ; 618 → 628 lignes au manifeste, aucune manquante).
- Textes : « L'arc électrique aime l'acier épais » (M5), « autos blindées » (épreuve du pont), fusées pour le Blériot et
  la Batterie Ruggieri ; le sélecteur lit le radium (×1,25 depuis WP4, il disait ×1,5) et le charbon dans `NATIONS`.
- Portraits : `models.html` en Empire montre le jeu rouge (Citadelle comprise), comme le sélecteur, le HUD et les fins.
- Atelier roulant (et Pasteur) d'une nation : ne répare plus une unité ou un bâtiment tombé à 0 PV dans le tick (il le
  ressuscitait avant `cleanupDeaths`) ; Classique inchangé (`classic-hash` vert), test `nations.test.ts`.
- IA des nations en escarmouche (`ai/goliath.ts` `finishingOff`, pas en campagne) : le QG ennemi tombé, toute unité libre
  qui peut la toucher chasse sa dernière super-unité, de partout, et les aérodromes gardent 8 chasseurs contre un Zénith.
  Archipel 44 → 42 nulles sur 120 : seules 3 nulles sur 44 étaient un QG tombé ; les autres sont des impasses d'îles,
  QG debout et mines vides à 25:00. Essayé et écarté : le Titan chargé à 3 (`UNITS.titan.capacity`) — Rép 11 % sur
  l'Archipel, pas moins de nulles.

**Campagne après WP4** (`npx vite-node tools/ops.ts campaign 3`, idle sur 2 graines) : M7 était à 1/3 (Boom impérial au
GQG vers 3:30), M9 à 0/3 (le général scripté débordé), M11 à 1/3. Réglages : M7 revenu ennemi 80 % et assaut à 2 400
(6/6 sur 6 graines), M9 revenu ennemi 80 % (6/6), M11 vagues toutes les 43 s au lieu de 40 (11/12 ; ★★★ « en 7:30 »).
| Mission | Pilote | Gagné | | Mission | Pilote | Gagné |
|---|---|---|---|---|---|---|
| M1 bridgehead | holder | 3/3 | | M7 col-des-aigles | escort | 3/3 |
| M2 harvest-moon | miner | 3/3 | | M8 sky-pirates | raider | 3/3 |
| M3 granit | raider | 3/3 | | M9 glass-jaw | general | 3/3 |
| M4 carbonie | gunner | 3/3 | | M10 decapitation | strike | 3/3 |
| M5 iron-tide | holder | 3/3 | | M11 last-light | defender | 2/3 |
| M6 frozen-assets | rusher | 3/3 | | M12 dame-de-fer | tower | 3/3 |
Pilote immobile : perdu partout (0/2). Épreuves Classique identiques à `feat/camps-camp`.

**Équilibre final** (`pacing.ts run --nations rep-emp --seeds 2 --jobs 10`, 720 parties, 386 s) : République **52 %
[48–55]** (n = 643 décidées), 77 nulles (10,7 %, dont 52 sur l'Archipel) ; durée médiane 11:11. Par carte : Terrain
d'essai 37 %, Terres fluviales 75 %, Mer de dunes 43 %, Engelure 60 %, Cendres 59 %, Archipel 28 % (+52 nulles). Siège
de la Rép bleu 53 % / rouge 50 %. Super-unité alignée : Zénith 48 % des camps (7:19), Gargantua 43 % (7:56). Armée à
6:00 (médianes) 2 800 / 2 380 ; récolte à 4:00 11 600 / 9 700.

Vérifications : `tsc`, `vitest` (92 fichiers, 1 729 tests), `npm run build`, `smoke.mjs` 390×844, 844×390,
1280×800 rouge et `?style=original` (aperçu) : OK. En jeu (Chrome sans tête) : sélecteur à blasons, escarmouche
République contre Empire jusqu'à la fin (2:25), cartons et début de la mission 1, feuille du duel en ligne, `models.html`
par nation ; aucune erreur de console.

Restes : Terres fluviales (75 %) et Archipel (28 %, nulles) hors cible ; impasses d'îles à traiter par l'IA de
transport (Titan, levage à deux) avec un nouveau panel ; M11 à 2/3 sur les graines 1–3 (11/12 sur 12).

