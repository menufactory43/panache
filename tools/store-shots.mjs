// Les captures de la fiche App Store, en paysage : l'iPhone 6,9" (2868 × 1320) dans ios/store/shots/<langue>/, l'iPad
// 13" (2732 × 2048) dans ios/store/shots-ipad/<langue>/, l'écran extérieur de l'iPhone Duo (2034 × 1398) dans
// ios/store/shots-duo/<langue>/.
//   npm run build && node tools/store-shots.mjs [fr|en] [iphone|ipad|duo]
// L'accueil est pris comme un joueur le voit (sans le drapeau des robots, l'intro déjà vue) ; les batailles le sont
// en spectateur d'une escarmouche IA contre IA, à quelques moments.
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const lang = process.argv[2] === "en" ? "en" : "fr";
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../dist");
const DEVICES = {
  iphone: { dir: "shots", viewport: { width: 956, height: 440 }, deviceScaleFactor: 3 },
  ipad: { dir: "shots-ipad", viewport: { width: 1366, height: 1024 }, deviceScaleFactor: 2 },
  duo: { dir: "shots-duo", viewport: { width: 1017, height: 699 }, deviceScaleFactor: 2 }
};
const device = DEVICES[process.argv[3] ?? "iphone"];
if (!device) throw new Error("usage : node tools/store-shots.mjs [fr|en] [iphone|ipad|duo]");
const OUT = join(HERE, `../ios/store/${device.dir}/${lang}`);
mkdirSync(OUT, { recursive: true });
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".webp": "image/webp", ".json": "application/json", ".mp3": "audio/mpeg", ".mp4": "video/mp4" };
const server = createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p.endsWith("/")) p += "index.html";
  const file = join(ROOT, p);
  if (!existsSync(file)) return void (res.writeHead(404), res.end());
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(8897, r));
const base = `http://localhost:8897/${lang === "en" ? "en/" : ""}`;
const exe = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"].find((p) => existsSync(p));
const browser = await chromium.launch({ executablePath: exe, args: ["--use-gl=angle", "--use-angle=metal", "--ignore-gpu-blocklist"] });
const VIEW = { viewport: device.viewport, deviceScaleFactor: device.deviceScaleFactor, hasTouch: true, isMobile: true };
const shot = (page, name) => page.screenshot({ path: join(OUT, `${name}.jpg`), type: "jpeg", quality: 90 }).then(() => console.log(`${lang}/${name}.jpg`));

// the hub, as a player sees it
{
  const page = await browser.newPage(VIEW);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    localStorage.setItem("panache.intro.seen", "1");
    localStorage.setItem("battledrones.tutorial", "done");
  });
  await page.goto(base, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  await page.mouse.click(device.viewport.width / 2, device.viewport.height / 2);
  await page.waitForTimeout(4500);
  await shot(page, "1-accueil");
  // the duel: ranked match and the ladder
  if (device.dir !== "shots-duo") {
  await page.evaluate(() => document.querySelector('.qg-ri[data-p="duel"]')?.click());
  await page.waitForTimeout(600);
  await page.evaluate(() => document.querySelector("#qg-go")?.click());
  await page.waitForTimeout(1500);
  await shot(page, "5-duel");
  }
  await page.close();
}

// battles, watched
for (const [name, seconds, map] of [["2-bataille", 150, "riverlands"], ["3-assaut", 330, "dune-sea"], ["4-front", 240, "frostbite"]]) {
  // the AI's matches differ each time: one already over at that moment is played again
  for (let tries = 1; tries <= 6; tries++) {
    const page = await browser.newPage(VIEW);
    await page.addInitScript((m) => {
      localStorage.setItem("panache.intro.seen", "1");
      const k = "battledrones.settings";
      const cur = JSON.parse(localStorage.getItem(k) || "{}");
      localStorage.setItem(k, JSON.stringify({ ...cur, mapId: m, mode: "skirmish" }));
    }, map);
    await page.goto(base, { waitUntil: "networkidle" });
    await page.click("#play-spectate");
    await page.waitForFunction(() => window.__bd?.world?.tick > 0, null, { timeout: 60_000 });
    // fast-forward the watched match, 10 s at a time, then let it draw a few frames
    const alive = await page.evaluate((s) => {
      const { world: w, scene } = window.__bd;
      for (let t = 0; t < s; t += 10) {
        scene.step(100, 100, false);
        if (w.winner) return false;
      }
      return true;
    }, seconds);
    if (!alive) {
      await page.close();
      continue;
    }
    // the camera onto the fight: the closest pair of enemies
    await page.evaluate(() => {
      const w = window.__bd.world;
      const us = [...w.units.values()];
      let best = null;
      for (const a of us) for (const b of us) {
        if (a.faction !== "blue" || b.faction !== "red") continue;
        const d = (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
        if (!best || d < best.d) best = { d, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      }
      window.__bd.scene.cutTo(best?.x ?? null, best?.y ?? null, "blue", 34);
    });
    await page.waitForTimeout(2500);
    const over = await page.evaluate(() => Boolean(window.__bd.world.winner));
    if (!over) await shot(page, name);
    await page.close();
    if (!over) break;
  }
}
await browser.close();
server.close();
