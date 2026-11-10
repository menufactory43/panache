// Le Creusot cuit en vraie partie (IA contre IA) : on en pose quelques-uns près du QG bleu et on photographie
// à deux niveaux de zoom.  node tools/modeles-hd-jeu.mjs [dossier] [port] [requête, ex. hd=0]
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const out = process.argv[2] ?? "progress-shots/modeles-hd";
const port = process.argv[3] ?? "5173";
const extra = process.argv[4] ?? "";
const tag = extra ? `-${extra.replace(/\W+/g, "")}` : "";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.log("ERREUR", e.message));
page.on("console", (m) => (m.type() === "error" || /baked|THREE/.test(m.text())) && console.log(m.type(), m.text()));
await page.goto(`http://localhost:${port}/?${extra}`, { waitUntil: "networkidle" });
await page.waitForTimeout(800);
await page.evaluate(() => document.querySelector("#play").click());
await page.waitForSelector(".op-card", { timeout: 30000 });
await page.waitForTimeout(600);
await page.click(".op-card");
await page.waitForFunction(() => window.__bd?.world?.tick > 5, null, { timeout: 60000 });
const at = await page.evaluate(() => {
  const { world, spawn } = window.__bd;
  // (la caméra s'ouvre sur notre QG : on pose les chars à côté, vers le milieu de la carte)
  const cam = window.__bd.cam;
  const dx = Math.sign(world.width / 2 - cam.x) || 1, dy = Math.sign(world.height / 2 - cam.y) || 1;
  const cx = cam.x + dx * 4.5, cy = cam.y + dy * 3.5;
  const K = ["mastodon", "stinger", "mortar", "harvester", "flak-crawler", "lancer", "fourgon", "jamais-contente", "de-dion", "branly", "estafette", "mortier-280", "atelier",
    "scout", "wasp", "raptor", "hornet", "mender", "condor", "gyroptere", "epervier", "vulcain", "titan"];
  K.forEach((k, i) => {
    const air = i >= 13;
    const col = (air ? i - 13 : i) % 7, row = Math.floor((air ? i - 13 : i) / 7) + (air ? 2 : 0);
    const u = world.units.get(spawn(k, i % 5 === 4 ? "red" : "blue", cx + (col - 3) * 1.55, cy + (row - 1.5) * 1.6));
    u.facing = (0.7 + i * 1.9) % 6.28;
  });
  return { cx, cy };
});
const view = async (zoom, name) => {
  await page.evaluate(({ at, zoom }) => {
    const { cam, scene } = window.__bd;
    cam.zoom = zoom;
    cam.centerOn(at.cx, at.cy + 0.3);
    for (let k = 0; k < 4; k++) scene.update(16);
  }, { at, zoom });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}/${name}${tag}.png` });
  console.log(name + tag);
};
await page.waitForTimeout(600);
await view(80, "10-en-partie-zoom");
await view(46, "11-en-partie");
await browser.close();
