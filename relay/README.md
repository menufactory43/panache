# panache-relais

Le relais du duel en ligne de Panache (« 🌐 Défier un ami (en ligne) »). Un Cloudflare Worker et un Durable Object
par salon : l'hôte et l'invité s'y branchent par WebSocket, et chaque paquet de l'un part tel quel chez l'autre.
Tout le reste (appairage, lockstep, synchro, revanche) se fait dans le jeu, comme pour le duel par le son
(`src/versus/online.ts`, `SOUND-DUEL.md`).

En ligne : **https://panache-relais.meffysto.workers.dev** (le jeu l'appelle en `wss://`, `RELAY_URL` dans
`src/versus/online.ts`).

## Protocole

```
wss://panache-relais.meffysto.workers.dev/salon/ABCD?role=hote|invite&cle=<clé>[&nouveau=1]
```

- **Code** : 4 lettres (sans I ni O). L'hôte en tire un et crée le salon (`nouveau=1`) ; un code déjà pris ferme la
  connexion en 4010 et le jeu en tire un autre. L'invité entre avec le code (lien `…/panache/?salon=ABCD`).
- **Places** : deux (hôte, invité), chacune tenue par une clé que le jeu tire et garde dans son `sessionStorage`.
  Celui qui revient avec sa clé dans la minute (`RECONNEXION_MS`) reprend sa place : une coupure réseau, un tunnel,
  la Revanche qui recharge la page. Sans la clé : 4009 (complet).
- **Messages** : le relais envoie `{"t":"salut","role":…,"pair":bool}` à l'arrivée et `{"t":"pair","on":bool}`
  quand l'autre arrive ou s'en va. Il ne fait suivre que les paquets du jeu (`p<bits> <base64>`, 512 caractères au
  plus, 40/s en moyenne par connexion) ; `ping` reçoit `pong` sans réveiller le salon (hibernation).
- **Fermetures** : 4000 remplacé (même place rouverte ailleurs), 4003 origine, 4004 salon introuvable, 4008 trop de
  messages, 4009 complet, 4010 code pris, 4011 expiré.
- **Ménage** : un salon vide est effacé à la fin de sa fenêtre de reconnexion (alarme du DO), et aucun ne vit plus de
  12 h.
- **Origines** : `https://menufactory43.github.io`, `localhost` / `127.0.0.1` et les adresses du réseau local (pour
  essayer sur un téléphone). Sans en-tête `Origin` (un outil, un test) : admis.

La logique des salons est dans `src/salon.ts`, en fonctions pures testées sous Node (`tests/online.test.ts` à la
racine) ; `src/index.ts` l'applique aux WebSockets et au stockage du Durable Object.

## Mettre en ligne

Le jeton Cloudflare est celui de famcrawl (fnox) ; il ne va que dans l'environnement du processus :

```sh
cd relay
export CLOUDFLARE_API_TOKEN=$(cd ~/famcrawl && fnox get CLOUDFLARE_API_TOKEN)
npx wrangler@4 deploy
```

## En local

```sh
cd relay && npx wrangler@4 dev          # http://localhost:8787
# puis le jeu avec ?relais=ws://localhost:8787 (gardé dans le lien d'invitation)
```
