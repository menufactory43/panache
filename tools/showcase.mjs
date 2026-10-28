// Visual QA: stage a close-up skirmish with every unit type and capture
// frames mid-fight (tracers, rockets, lasers, shells, bombs, heal beams,
// robot squads' rifle crackle and rail shots, a Condor hovering to drop).
// Usage: node tools/showcase.mjs [url] [outDir]   (Vite dev server by default)
import { chromium } from "playwright-core";
import { existsSync, mkdirSync } from "node:fs";

const [, , url = "http://localhost:5173/", out = "/tmp/showcase"] = process.argv;
mkdirSync(out, { recursive: true });
const exe = ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome"].find((p) => existsSync(p));
const browser = await chromium.launch({
  executablePath: exe,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
});
const page = await browser.newPage({ viewport: { width: 900, height: 600 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto(url, { waitUntil: "networkidle" });
await page.evaluate(
  (m) => localStorage.setItem("panache.settings", JSON.stringify({ mapId: m, difficulty: "normal" })),
  process.env.MAP ?? "dune-sea"
);
await page.reload({ waitUntil: "networkidle" });
await page.click("#play-spectate");
await page.waitForFunction(() => window.__bd?.world?.tick > 2, null, { timeout: 30000 });
await page.waitForTimeout(1500);

// clear the stage and set up two armies facing each other in the open
await page.evaluate(() => {
  const { world: w, cam } = window.__bd;
  const cx = Math.floor(w.width / 2);
  const cy = Math.floor(w.height / 2) + 6;
  const add = (kind, faction, x, y) => {
    const id = w.nextId++;
    const u = {
      id, kind, faction, x, y, hp: 999, facing: faction === "blue" ? Math.PI / 2 : -Math.PI / 2,
      aim: 0, order: { type: "idle" }, path: null, pathGoal: null, cargo: kind === "harvester" ? 100 : 0,
      cooldown: 0, autoTargetId: null, damagedTick: -1000, lastAttackerId: null, firedTick: -1000, xp: 0, rank: 0, kills: 0
    };
    if (kind === "condor") u.passengers = [];
    w.units.set(id, u);
    return u;
  };
  const blue = [["mastodon", 0, 0], ["lancer", 0, 1.4], ["stinger", 0, -1.4], ["mortar", -3, 0.6], ["flak-crawler", -1.5, 2.2],
    ["wasp", 1, -2.4], ["hornet", 1.4, 2.6], ["mender", -1.2, -1.2], ["raptor", 0.6, 3.6],
    ["trooper", 1.2, 1.2], ["rocket-squad", -1.8, -2.6], ["sniper", -3.6, -1.6]];
  const red = [["mastodon", 5, 0], ["stinger", 5.2, 1.6], ["flak-crawler", 5.5, -1.5], ["wasp", 4, 3], ["raptor", 4.2, -3],
    ["lancer", 6.4, 2.6], ["harvester", 7, -0.5], ["trooper", 3.6, 1.4], ["rocket-squad", 4.4, -0.2]];
  for (const [k, dx, dy] of blue) add(k, "blue", cx - 3 + dx, cy + dy);
  for (const [k, dx, dy] of red) add(k, "red", cx - 1 + dx, cy + dy);
  // a loaded Condor coming down to drop its squads behind the line
  const condor = add("condor", "blue", cx - 4.6, cy + 2.4);
  for (const k of ["trooper", "sniper"]) {
    const p = add(k, "blue", 0, 0);
    w.units.delete(p.id);
    condor.passengers.push(p);
  }
  condor.order = { type: "unload", x: cx - 4.6, y: cy + 2.4, hover: -1 };
  // real hp values so health bars read correctly
  for (const u of w.units.values()) u.hp = Math.min(u.hp, 400) * 0.8;
  for (const p of condor.passengers) p.hp = Math.min(p.hp, 400) * 0.8;
  cam.zoom = 90;
  cam.centerOn(cx, cy);
});
for (let i = 0; i < 4; i++) {
  for (let k = 0; k < (i === 0 ? 20 : 9); k++) {
    await page.evaluate(() => window.__bd.scene.update(33));
  }
  await page.waitForTimeout(80);
  await page.screenshot({ path: `${out}/showcase-${i}.png` });
}
console.log(errors.length ? errors.join("\n") : "no errors");
await browser.close();
