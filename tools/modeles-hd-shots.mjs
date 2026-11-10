// Photos de l'essai « modèles haute fidélité » (tools/modeles-hd.html), avec `npm run dev` lancé :
//   node tools/modeles-hd-shots.mjs [dossier] [port] [filtre]          le Creusot sous cinq angles
//   node tools/modeles-hd-shots.mjs [dossier] [port] u=stinger b=hq…   un avant/après par modèle nommé
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const out = process.argv[2] ?? "progress-shots/modeles-hd";
const port = process.argv[3] ?? "5173";
const rest = process.argv.slice(4);
mkdirSync(out, { recursive: true });
const CREUSOT = [
  ["01-bleu", "zoom=330&turn=0.6&head=0.25&pitch=47", 1600, 900],
  ["02-rouge", "zoom=330&turn=-2.4&head=-0.3&faction=red&pitch=47", 1600, 900],
  ["03-dos", "zoom=330&turn=2.6&head=0.2&pitch=47", 1600, 900],
  ["04-taille-jeu", "zoom=70&turn=0.6&head=0.25&gap=1.6&pitch=58", 640, 360],
  ["05-profil", "zoom=330&turn=1.5708&pitch=14&y=-0.5", 1600, 900]
];
const named = rest.filter((a) => a.includes("="));
const SHOTS = named.length
  ? named.map((a) => {
      const building = a.startsWith("b=");
      return [`m-${a.replace(/[=@]/g, "-")}`, `${a}&turn=-2.5&head=-0.3&pitch=47&zoom=${building ? 150 : 300}&gap=${building ? 4.2 : 2}&y=${building ? -0.6 : -0.25}`, 1400, 700];
    })
  : CREUSOT.filter((s) => !rest[0] || s[0].includes(rest[0]));
const browser = await chromium.launch({ channel: "chrome", args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });
for (const [name, query, w, h] of SHOTS) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
  page.on("pageerror", (e) => console.log("ERREUR", e.message));
  page.on("console", (m) => m.type() === "error" && console.log(m.text()));
  await page.goto(`http://localhost:${port}/tools/modeles-hd.html?${query}`);
  await page.waitForFunction("window.ready === true", null, { timeout: 30000 });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${out}/${name}.png` });
  await page.close();
  console.log(name);
}
await browser.close();
