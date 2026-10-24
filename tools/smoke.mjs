// Headless smoke test: serves dist/ (or uses a given URL), boots the game
// and drives the REAL input paths with taps: pick an opener card, construct
// + place a building (tap moves the ghost, tapping the ghost builds), queue
// a Stinger, select it on the canvas, save it as squad 1 and order it around,
// open an info card, pause/resume. Fails on any console error.
// The Belle Époque HUD (src/ui/belle-hud.ts, the default) keeps the build bar in a
// drawer behind 🔨 Construire: the flow opens it first; ?style=original drives the
// classic bar (the style is read from the page).
// --side=red plays the same flow as red against a blue AI (/?side=red, DUEL.md
// "Playing red"); every check asks the page which side it plays (window.__bd.player).
// Usage: node tools/smoke.mjs [width] [height] [--shots] [url] [--side=red]
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../dist");
const SHOT_DIR = process.env.SMOKE_SHOT_DIR ?? "/tmp";
const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".png": "image/png", ".webp": "image/webp", ".json": "application/json",
  ".webmanifest": "application/manifest+json"
};
const sideArg = process.argv.slice(2).find((a) => a.startsWith("--side="));
const side = sideArg ? sideArg.slice("--side=".length) : "blue";
if (side !== "blue" && side !== "red") throw new Error(`--side must be blue or red, not ${side}`);
const [w = "390", h = "844", shots = "", urlArg] = process.argv.slice(2).filter((a) => a !== sideArg);
let server = null;
if (!urlArg) {
  server = createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p.endsWith("/")) p += "index.html";
    const file = join(ROOT, p);
    if (!existsSync(file)) { res.writeHead(404); res.end("nf"); return; }
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  });
  await new Promise((r) => server.listen(8899, r));
}
const target = new URL(urlArg ?? "http://localhost:8899/");
if (side === "red") target.searchParams.set("side", "red");
const url = target.href;

const exe = ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((p) => existsSync(p));
const browser = await chromium.launch({
  executablePath: exe,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
});
const page = await browser.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: 2, hasTouch: true });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));
const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exitCode = 1; };
const shot = async (name) => { if (shots) await page.screenshot({ path: `${SHOT_DIR}/smoke-${name}-${w}x${h}${side === "red" ? "-red" : ""}.png` }); };
/** Run the game loop n × 100 ms of sim time without waiting in real time. */
const ff = (n) => page.evaluate((k) => window.__bd.scene.step(100, k), n);
const world = (fn, arg) => page.evaluate(fn, arg);

await page.goto(url, { waitUntil: "networkidle" });
await page.evaluate(() => localStorage.setItem("battledrones.settings", JSON.stringify({ mapId: "riverlands", difficulty: "easy" })));
await page.reload({ waitUntil: "networkidle" });
await shot("menu");
await page.tap("#play");
// the opener cards hold the clock until one is picked
await page.waitForSelector(".op-card", { timeout: 30000 });
await page.waitForTimeout(600);
await shot("openers");
if ((await world(() => window.__bd.world.tick)) !== 0) fail("the sim ran before an opener was picked");
const player = await world(() => window.__bd.player);
if (player !== side) fail(`the page plays ${player}, not ${side}`);
// the cards show our own side's paint
const cardArt = await page.locator(".op-card img").evaluateAll((els) => els.map((e) => e.getAttribute("src")));
if (!cardArt.length || !cardArt.every((src) => src.includes("/red/") === (side === "red"))) fail(`opener card art not in ${side}'s paint: ${JSON.stringify(cardArt)}`);
// Air Wing leaves the Fab Plant to build by hand below
await page.locator(".op-card[data-id=airwing]").tap();
await page.waitForFunction(() => window.__bd?.world?.tick > 5, null, { timeout: 30000 });
const opened = await world(() => {
  const { world: w, player: me } = window.__bd;
  const mine = (k) => [...w.units.values()].filter((u) => u.faction === me && u.kind === k).length;
  return { airpad: [...w.buildings.values()].some((b) => b.faction === me && b.kind === "airpad"), wasps: mine("wasp"), harvesters: mine("harvester") };
});
if (!opened.airpad || opened.wasps !== 3 || opened.harvesters !== 2) fail(`Air Wing opener not applied: ${JSON.stringify(opened)}`);
await page.waitForTimeout(500);
await shot("start");

// the sim advances at ~10 ticks/sec in real time (after texture-upload warm-up;
// headless Chrome renders in software, so be lenient)
await page.waitForTimeout(2500);
const t1 = await world(() => window.__bd.world.tick);
await page.waitForTimeout(3000);
const t2 = await world(() => window.__bd.world.tick);
if (t2 - t1 < 15) fail(`sim too slow: ${t2 - t1} ticks in 3s`);

// the starting harvester goes to work on its own
await ff(60);
const mining = await world(() => [...window.__bd.world.units.values()].some((u) => u.faction === window.__bd.player && u.kind === "harvester" && u.order.type === "harvest"));
if (!mining) fail("starting harvester is not harvesting");

// the HUD style: Panache's drawer and corner buttons, or the original build bar
const belle = await world(() => document.documentElement.classList.contains("belle") && document.getElementById("hud").classList.contains("bh"));
const sheetOpen = () => world(() => document.getElementById("hud").classList.contains("bh-sheet-open"));
/** Belle: open the build drawer (🔨 Construire) unless it is open. */
const openDrawer = async () => {
  if (!belle || (await sheetOpen())) return;
  await page.tap(".bh-build");
  await page.waitForTimeout(300); // (the slide-in)
  if (!(await sheetOpen())) fail("🔨 Construire did not open the build drawer");
};
const closeDrawer = async () => {
  if (!belle || !(await sheetOpen())) return;
  await page.tap(".bh-handle");
  await page.waitForTimeout(300);
  if (await sheetOpen()) fail("the drawer handle did not close the build drawer");
};
if (belle) {
  // the pill opens its panel (relays, speed, sound) and closes again
  await page.tap(".bh-pill");
  if (await page.locator(".bh-drop").isHidden()) fail("tapping the pill did not open its panel");
  if (!(await page.locator(".bh-drop #speed").count())) fail("the speed chip is not in the pill's panel");
  await page.tap(".bh-pill");
  if (await page.locator(".bh-drop").isVisible()) fail("tapping the pill again did not close its panel");
}

// 1. construct a Fab Plant from the build bar (real tap)
await openDrawer();
const btn = (name) => page.locator(".bb", { has: page.locator(".nm", { hasText: new RegExp(`^${name}$`) }) });
await btn("Forges").tap();
await ff(2);
const pending = await world(() => window.__bd.world.factions[window.__bd.player].pending?.kind);
if (pending !== "fab-plant") fail(`Fab tap did not start construction (pending=${pending})`);
await ff(110); // 10 s build
await openDrawer();
await btn("Forges").tap(); // ready: enter placement mode
const placing = await world(() => window.__bd.ctrl.placing);
if (placing !== "fab-plant") fail(`ready Fab tap did not enter placement (placing=${placing})`);
// (the HUD closes it on its next frame)
if (belle && !(await page.waitForFunction(() => !document.getElementById("hud").classList.contains("bh-sheet-open"), null, { timeout: 5000 }).then(() => true, () => false)))
  fail("entering placement did not close the build drawer");
// tap a valid spot near the HQ, found via the sim's own rules
const spot = await world(() => {
  const { world: w, cam, toScreen } = window.__bd;
  const hq = [...w.buildings.values()].find((b) => b.faction === window.__bd.player && b.kind === "hq");
  for (let r = 1; r < 7; r++)
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        const tx = hq.tx + dx, ty = hq.ty + dy;
        if (!window.__bd.canPlace(tx, ty)) continue;
        // the footprint centre (a 2×2 Fab) on the ground, put mid-screen
        cam.centerOn(tx + 1, ty + 1);
        const s = toScreen(tx + 1, ty + 1);
        return { sx: s.x, sy: s.y, tx, ty };
      }
  return null;
});
if (!spot) fail("no valid Fab spot found");
else {
  const isPlaced = () => world(() => [...window.__bd.world.buildings.values()].some((b) => b.faction === window.__bd.player && b.kind === "fab-plant"));
  // on touch a tap moves the ghost there (no build yet) …
  await page.touchscreen.tap(spot.sx, spot.sy);
  await page.waitForTimeout(350); // let the double-tap window lapse
  await ff(2);
  if (!(await isPlaced())) {
    const at = await world(() => window.__bd.ctrl.placeAt);
    if (!at || at.tx !== spot.tx || at.ty !== spot.ty) fail(`tapping the map did not move the ghost (placeAt=${JSON.stringify(at)})`);
    // … and tapping the ghost builds it
    await page.touchscreen.tap(spot.sx, spot.sy);
    await ff(3);
  }
  if (!(await isPlaced())) fail("tapping the ghost did not place the Fab Plant");
}
await shot("placed");

// 2. queue a Stinger from the Vehicles tab
await openDrawer();
await page.locator(".tab[data-tab=ground]").tap();
await btn("Panhard").tap();
await ff(3);
const queued = await world(() => [...window.__bd.world.buildings.values()].some((b) => b.kind === "fab-plant" && b.faction === window.__bd.player && b.queue.length > 0));
if (!queued) fail("Stinger tap did not queue production");
if (belle && !(await page.waitForFunction(() => document.querySelector(".bh-build .bh-badge")?.textContent === "1", null, { timeout: 5000 }).then(() => true, () => false))) fail("🔨 Construire's badge does not count the queued Stinger");
await closeDrawer();
await ff(80);
const sid = await world(() => [...window.__bd.world.units.values()].find((u) => u.faction === window.__bd.player && u.kind === "stinger")?.id);
if (!sid) fail("no Stinger was produced");

// 3. select it by tapping it on the canvas, then order it somewhere
if (sid) {
  await world((id) => {
    const u = window.__bd.world.units.get(id);
    window.__bd.cam.centerOn(u.x, u.y);
  }, sid);
  await ff(1);
  // where the tank is drawn (its body, on the tilted 3D view)
  const pos = await world((id) => {
    const s = window.__bd.screenOf(id);
    return { sx: s.x, sy: s.y };
  }, sid);
  await page.touchscreen.tap(pos.sx, pos.sy);
  await page.waitForTimeout(350); // let the double-tap window lapse
  const sel = await world(() => [...window.__bd.ctrl.selectedUnits]);
  if (!sel.includes(sid)) fail(`canvas tap did not select the Stinger (selected=${JSON.stringify(sel)})`);
  // hold squad chip 1: the selection is saved as squad 1
  const sq = await page.locator(".sq").first().boundingBox();
  await page.mouse.move(sq.x + sq.width / 2, sq.y + sq.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(550);
  await page.mouse.up();
  const squad = await world(() => window.__bd.ctrl.squads.slots[0]);
  if (!squad.includes(sid)) fail(`holding squad chip 1 did not save the Stinger (squad=${JSON.stringify(squad)})`);
  // the chip shows the squad's portrait, in our side's paint, from the next frame
  await page.waitForFunction(() => !!document.querySelector(".sq .sqi:not([hidden])"), null, { timeout: 5000 }).catch(() => {});
  const chip = await page.locator(".sq .sqi").first().getAttribute("src");
  if (!chip?.includes("stinger") || chip.includes("/red/") !== (side === "red")) fail(`squad chip not in ${side}'s paint: ${chip}`);
  // tap open ground: a spot next to the Stinger that no HUD toast or banner is covering
  const ground = await page.evaluate(({ sx, sy }) => {
    for (const [dx, dy] of [[60, -60], [60, 60], [-60, 60], [-60, -60], [90, 0], [-90, 0]]) {
      const el = document.elementFromPoint(sx + dx, sy + dy);
      if (el && el.tagName === "CANVAS") return { x: sx + dx, y: sy + dy };
    }
    return { x: sx + 60, y: sy - 60 };
  }, pos);
  await page.touchscreen.tap(ground.x, ground.y);
  await ff(2);
  const order = await world((id) => window.__bd.world.units.get(id)?.order.type, sid);
  if (order !== "attackMove" && order !== "idle") fail(`ground tap gave order ${order}`);
  if (order !== "attackMove") fail("ground tap did not issue attack-move");
  await shot("selected");
}

// ⚔ Armée (Belle) / "Toute l'armée" (original): selects the whole army
await world(() => window.__bd.ctrl.clearSelection());
await ff(1);
const armySel = belle ? ".bh-army" : '.chip[data-id="army"]';
if (await page.locator(armySel).count()) {
  await page.tap(armySel);
  await page.waitForTimeout(100);
  const all = await world(() => {
    const c = window.__bd.ctrl;
    return c.armyIds().every((id) => c.selectedUnits.has(id)) && c.selectedUnits.size > 0;
  });
  if (!all) fail(`${armySel} did not select the army`);
  await world(() => window.__bd.ctrl.clearSelection());
} else fail(`no ${armySel} button`);

// 4. long-press a build button: the info card opens
await openDrawer();
await page.locator(".tab[data-tab=air]").tap();
const wasp = btn("Éole");
const box = await wasp.boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
await page.waitForTimeout(600);
await page.mouse.up();
if (await page.locator("#card").isHidden()) fail("long-press did not open the info card");
await shot("card");
await page.locator("#card-x").click();
await closeDrawer();

// 5. pause and resume
await page.locator("#btn-menu").tap();
const paused = await world(() => window.__bd.ctrl.paused);
if (!paused || (await page.locator("#pause").isHidden())) fail("pause button did not pause");
await shot("paused");
await page.locator("#p-resume").tap();
if (await world(() => window.__bd.ctrl.paused)) fail("resume did not unpause");

// 6. the AI must be doing something
await ff(600);
// (HQ + its opener factory are free: it must have built something since)
const aiActive = await world(() => [...window.__bd.world.buildings.values()].filter((b) => b.faction !== window.__bd.player).length > 2);
if (!aiActive) fail("AI built nothing in the first minutes");
await shot("late");

if (errors.length) fail(`console errors: ${JSON.stringify(errors.slice(0, 10))}`);
console.log(process.exitCode ? "SMOKE FAILED" : `SMOKE OK (${w}x${h}, ${side})`);
await browser.close();
server?.close();
