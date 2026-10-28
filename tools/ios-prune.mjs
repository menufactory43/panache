// Ce que l'app iPhone n'embarque pas : le build (dist/) sert aussi le site, et ces fichiers-là ne sont qu'au site.
// Lancé entre `npm run build` et `cap sync ios` (npm run ios, ios:sync, tools/ios-testflight.sh).
//   decouvrir/, en/        les pages du site (présentation, lien de partage anglais)
//   og*.jpg, og*.mp4       les aperçus des liens partagés
//   battles/               les batailles de démonstration du site (vite.config.ts, showcaseBattles)
//   vehicles.html, record-viewer.html   des pages d'outils, sans lien depuis le jeu (l'Arsenal, models.html, reste)
// La licence Apache 2.0 du code d'origine part avec l'app (LICENSE.txt), comme la licence le demande.
import { copyFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = join(root, "dist");
if (!existsSync(join(dist, "index.html"))) throw new Error("dist/ n'est pas construit : npm run build d'abord");
const gone = ["decouvrir", "en", "battles", "vehicles.html", "record-viewer.html", ...readdirSync(dist).filter((f) => /^og.*\.(jpg|mp4)$/.test(f))];
for (const f of gone) rmSync(join(dist, f), { recursive: true, force: true });
copyFileSync(join(root, "LICENSE"), join(dist, "LICENSE.txt"));
console.log(`ios-prune : ${gone.join(", ")} retirés de dist/`);
