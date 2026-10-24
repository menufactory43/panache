// A game started while a cancelled duel lobby still says the end (DUEL.md
// "The lobby": Cancel after GO keeps the link on for 2 s, until the session
// may close, then lets the audio go and gives the menu back its music). The
// sheet goes at once and the menu's Play works meanwhile, so a game can start
// before the lobby lets go: its late release must leave that game's music
// alone. The built app at ?duel=loop (a practice link: no sound, no
// microphone) on a phone: Duel, Host, an opener, and once this phone has said
// GO, Cancel and at once Play (a skirmish against the AI). When the match is
// up and the lobby has had time to let go (5 s after Cancel), the music must
// be the battle's. Run at two friend latencies, as the timing of the scene's
// build against the lobby's 2 s varies.
//
// Fails on any console error. Prints "CANCEL THEN PLAY OK".
// Usage: node tools/duel-cancel-play.mjs [dist-dir | url]
// (serves dist/ by default: run `npm run build` first)
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".png": "image/png", ".webp": "image/webp", ".svg": "image/svg+xml", ".json": "application/json",
  ".webmanifest": "application/manifest+json"
};
/** The lobby's end goes out this long after Cancel (session.ts END_FRAMES_MS), and the check looks this long after. */
const LET_GO_MS = 5000;
const where = process.argv.slice(2).find((a) => !a.startsWith("--"));
let server = null;
let base = where && /^https?:/.test(where) ? where : null;
if (!base) {
  const root = resolve(where ?? join(dirname(fileURLToPath(import.meta.url)), "../dist"));
  server = createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p.endsWith("/")) p += "index.html";
    const file = join(root, p);
    if (!existsSync(file)) { res.writeHead(404); res.end("nf"); return; }
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  });
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}/`;
}

const exe = ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome"].find((p) => existsSync(p));
const browser = await chromium.launch({
  executablePath: exe,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"]
});
const problems = [];

for (const latency of [600, 1500]) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, serviceWorkers: "block" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  const at = `latency ${latency} ms`;
  await page.goto(new URL(`?duel=loop&latency=${latency}`, base).href, { waitUntil: "networkidle" });
  await page.waitForSelector("#play-online:not([disabled])", { timeout: 30000 });
  await page.locator("#play-online").tap();
  await page.locator(".duel-role[data-act=host]").tap();
  await page.waitForSelector(".duel-cards .op-card", { timeout: 45000 });
  await page.locator(".duel-cards .op-card").first().tap();
  // (this phone said GO: from here on Cancel says the end before letting go)
  await page.waitForFunction(() => ["go", "loading"].includes(window.__duel?.state ?? ""), null, { timeout: 45000, polling: 20 });
  await page.locator(".duel-actions [data-act=cancel]").tap();
  const cancelAt = Date.now();
  await page.locator("#play").tap();
  await page.waitForFunction(() => !!window.__bd?.scene, null, { timeout: 60000, polling: 50 });
  const sceneMs = Date.now() - cancelAt;
  await page.waitForTimeout(Math.max(0, LET_GO_MS - (Date.now() - cancelAt)));
  const state = await page.evaluate(() => ({ music: window.__bd.music.state.mode }));
  console.log(`${at}: the game's scene ${sceneMs} ms after Cancel; ${LET_GO_MS} ms after it the music is "${state.music}"`);
  if (state.music !== "battle") problems.push(`${at}: the game plays "${state.music}" music, not the battle's`);
  if (errors.length) problems.push(`${at}: console errors: ${errors.join(" | ")}`);
  await ctx.close();
}

await browser.close();
server?.close();
if (problems.length) {
  for (const p of problems) console.error(`FAIL: ${p}`);
  process.exitCode = 1;
} else console.log("CANCEL THEN PLAY OK");
