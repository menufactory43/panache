# Panache en anglais

Le jeu parle français ou anglais (`src/lang.ts`). La langue est choisie au chargement : celle des Réglages, sinon celle du téléphone. Changer de langue recharge la page.

## Le principe

Le texte est écrit sur place, les deux langues côte à côte :

```ts
import { tr } from "../lang";

button.textContent = tr("Reprendre", "Resume");
`${tr("Op du jour", "Daily Op")} #${n}`
tr(`Record : ${n} vague${n > 1 ? "s" : ""}`, `Best: ${n} wave${n > 1 ? "s" : ""}`)
const LINES = tr({ … français … }, { … anglais … });   // une table entière
```

`EN` (booléen) sert quand la construction de la phrase change (`EN ? … : …`).

Modèle déjà traduit : `src/ui/qg.ts`, le menu pause de `src/ui/hud.ts`, les Réglages de `src/main.ts`, les noms de `src/sim/balance.ts`, `src/sim/lexicon.ts`, `src/sim/powers.ts`, `src/sim/ai/commander.ts`.

## Règles

1. **Seul le texte vu ou entendu par le joueur se traduit.** Jamais : identifiants (`"harvester"`, `"easy"`, `data-*`, classes CSS, clés `localStorage`), messages du relais ou du duel, texte comparé (`=== "…"`), commentaires (ils restent en anglais), `console.*`.
2. **Le français ne change pas d'un caractère.** Il reste le premier argument de `tr`, tel quel. Les tests vérifient le texte français : ils doivent passer sans modification.
3. **La simulation reste identique.** Rien de traduit n'entre dans le monde, les ordres, les enregistrements ni les hachages (`tests/lang.test.ts`).
4. **La grammaire.** `theName`, `aName`, `isVerb` savent l'anglais. `agree()` est réservé au français : `tr(agree(k, "détruit"), "destroyed")`. Les pluriels anglais sont dans `PLURALS` (`pluralName`).
5. **Dates et nombres :** `toLocaleDateString(tr("fr-FR", "en-GB"), …)`.
6. **Voix radio** (`src/game/voice-lines.ts`, `callouts.ts`) : à traduire comme le reste. Chaque réplique anglaise sera enregistrée ; garde-les courtes, dites à la radio.
7. **Longueur :** l'anglais est souvent plus court. S'il est plus long, rester près de la longueur française (boutons, onglets).

## Ton

Belle Époque, Paris 1900, un rien de panache. On tutoie en français, on dit « you » en anglais. Phrases courtes et directes dans l'interface ; les briefings et intertitres peuvent avoir du style (« The Great Battle of the Bridge », « Forward! »). Anglais britannique (armoured, colour).

## Glossaire

Noms propres et marques gardés ; noms communs traduits.

| Français | Anglais |
|---|---|
| Fardier | Steam Wagon |
| Patrie | Patrie |
| Panhard | Panhard |
| Faucheux | Daddy-Longlegs |
| Canon de 75 | French 75 |
| Creusot | Creusot |
| Hydroglisseur | Hydroglider |
| Éole, Blériot, Albatros, Pasteur | (inchangés) |
| Escouade de pioupious / pioupious | Poilu Squad / poilus |
| Escouade d'artificiers | Rocketeer Squad |
| Section de chasseurs alpins | Alpine Chasseur Section |
| Montgolfière | Montgolfier Balloon |
| Gargantua | Gargantua |
| Fourgon Jeantaud | Jeantaud Van |
| Jamais-Contente | Jamais-Contente |
| Autocanon De Dion | De Dion Autocannon |
| Canon Branly | Branly Gun |
| Escouade de sapeurs-électriciens | Electric Sapper Squad |
| Zénith, Titan | (inchangés) |
| Estafette | Dispatch Rider |
| Mortier de 280 | 280 mm Mortar |
| Gyroptère | Gyropter |
| Épervier | Sparrowhawk |
| Vulcain | Vulcan |
| Atelier roulant | Rolling Workshop |
| Escouade de fusiliers | Fusilier Squad |
| Section de carabiniers | Carabinier Section |
| GQG (Grand Quartier Général) | GHQ (General Headquarters) |
| Forges, Polytechnique, Hotchkiss, Galerie des Machines | (inchangés) |
| Parc de Chalais-Meudon | Chalais-Meudon Airpark |
| Halles | Market Halls |
| Batterie Ruggieri | Ruggieri Battery |
| Tour TSF | Wireless Tower |
| Manufacture | Manufactory |
| Bobine d'Arsonval | d'Arsonval Coil |
| Batterie de 47 | 47 mm Battery |
| la République / l'Empire de Carbonie | the Republic / the Empire of Carbonia |
| Citadelle, Haut-fourneau, Aérodrome à vapeur | Citadel, Blast Furnace, Steam Aerodrome |
| Ballon captif, Caserne-atelier | Tethered Balloon, Workshop Barracks |
| Garage électrique Jeantaud, Station de charge, Hangar du Zénith | Jeantaud Electric Garage, Charging Station, Zénith Hangar |
| Feu roulant, Fée Électricité, Obus-capsule, Obus Méliès | Rolling Barrage, Electricity Fairy, Capsule Shell, Méliès Shell |
| Ballon-sonde, Rayon Curie, Gaz de houille, Pression des chaudières | Sounding Balloon, Curie Ray, Coal Gas, Boiler Pressure |
| charbon, radium | coal, radium |
| Escarmouche, Survie, Campagne, Duel | Skirmish, Last Stand, Campaign, Duel |
| Campagne de 1900, Épreuves | The 1900 Campaign, Trials |
| Op du jour | Daily Op |
| Instruction | Training |
| Archives, rediffusion | Archives, replay |
| Temps forts | Highlights |
| Mutateurs | Mutators |
| Salon | Lobby |
| Réseau électrique, Réseau TSF, Tranchées | Power Grid, Wireless Net, Trenches |
| Facile, Normal, Difficile | Easy, Normal, Hard |
| En avant ! | Forward! |
| brouillard | fog |

## Termes ajoutés pendant la traduction du jeu

| Français | Anglais |
|---|---|
| Quartier général (menu) | Headquarters |
| Salon (code, lien d'invitation) | Lobby |
| Duel sonore / Duel en ligne | Sound Duel / Online Duel |
| Défier un ami | Challenge a friend |
| Liaison sonore | sound link |
| Relais TSF | Wireless Relay (Relay) |
| Caisse de ravitaillement | Supply crate |
| Ouverture : Blitz, Industrie, Escadrille | Opening: Blitz, Industry, Air Wing |
| Mutateurs : Ruée vers l'or, Canons de verre, Production éclair, Guerre aérienne, Guerre d'infanterie, Aéroportés, Vétérans, Ciel dégagé, Nomades, Amour mécanique, Armada de Gargantuas | Gold Rush, Glass Cannons, Lightning Production, Air War, Infantry War, Airborne, Veterans, Clear Skies, Nomads, Robot Love, Gargantua Armada |
| Grades : Cadet, Soldat, Caporal, Sergent, Lieutenant, Capitaine, Commandant, Colonel, Général, Maréchal | Cadet, Private, Corporal, Sergeant, Lieutenant, Captain, Major, Colonel, General, Marshal |
| Épreuve / Mission | Trial / Mission |
| Instruction (écran) | Training |
| Acte I, II, III | Act I — The Ultimatum, Act II — The War of the Peaks, Act III — Paris! |
| Bleu / Rouge | Blue / Red |
| GQG (message) | GHQ |
