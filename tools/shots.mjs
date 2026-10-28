// Screenshot tour for visual QA: menu, early game, a spectated battle.
// Usage: node tools/shots.mjs [url] [outDir] [width] [height] [dpr]
// Default url is the Vite dev server (npx vite --port 5173).
import { chromium } from "playwright-core";
import { existsSync, mkdirSync } from "node:fs";

const [, , url = "http://localhost:5173/", out = "/tmp/shots", w = "390", h = "844", dpr = "2"] = process.argv;
mkdirSync(out, { recursive: true });
const exe = ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome"].find((p) => existsSync(p));
const browser = await chromium.launch({
  executablePath: exe,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
});
const page = await browser.newPage({
  viewport: { width: +w, height: +h },
  deviceScaleFactor: +dpr,
  hasTouch: true,
  isMobile: +w < +h
});
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning") errors.push(`${m.type()}: ${m.text()}`);
});
page.on("pageerror", (e) => errors.push(String(e)));
const tag = `${w}x${h}`;
const map = process.env.MAP;

await page.goto(url, { waitUntil: "networkidle" });
if (map) await page.evaluate((m) => localStorage.setItem("panache.settings", JSON.stringify({ mapId: m, difficulty: "normal" })), map);
if (map) await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(600);
await page.screenshot({ path: `${out}/menu-${tag}.png` });

const spectate = process.env.SPECTATE === "1";
await page.click(spectate ? "#play-spectate" : "#play");
if (!spectate) {
  // pick an opener (OPENER=blitz|industry|airwing, default the first card)
  await page.waitForSelector(".op-card", { timeout: 30000 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${out}/openers-${tag}.png` });
  await page.click(process.env.OPENER ? `.op-card[data-id=${process.env.OPENER}]` : ".op-card");
}
await page.waitForFunction(() => window.__bd?.world?.tick > 5, null, { timeout: 30000 });
await page.waitForTimeout(1500);
await page.screenshot({ path: `${out}/start-${tag}.png` });

// fast-forward the sim headlessly, then look around
const fastForward = async (ticks) => page.evaluate((n) => window.__bd.scene.step(100, n), ticks);

if (spectate) {
  for (const [i, t] of [1800, 1200, 900].entries()) {
    await fastForward(t);
    await page.waitForTimeout(200);
    // centre on the biggest fight
    await page.evaluate(() => {
      const { world, cam } = window.__bd;
      const us = [...world.units.values()].filter((u) => u.kind !== "harvester");
      if (!us.length) return;
      let best = us[0], bestN = -1;
      for (const u of us) {
        const n = us.filter((o) => o.faction !== u.faction && Math.hypot(o.x - u.x, o.y - u.y) < 7).length;
        if (n > bestN) { bestN = n; best = u; }
      }
      cam.centerOn(best.x, best.y);
    });
    for (let k = 0; k < 8; k++) {
      await page.evaluate(() => window.__bd.scene.update(16));
      await page.waitForTimeout(60);
    }
    await page.screenshot({ path: `${out}/battle${i}-${tag}.png` });
  }
} else {
  await fastForward(600);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}/minute1-${tag}.png` });
}
console.log(errors.length ? errors.slice(0, 20).join("\n") : "no console errors");
await browser.close();
