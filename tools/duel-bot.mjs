// A sparring partner for the online duel, for playing one with no friend at hand: a headless page joins the
// lobby by its code, takes the nation and opener on offer, and plays its side with the game's own AI (the
// commander, as in a skirmish), every order going through the duel's lockstep like a player's tap.
//
// The phone hosts (🌐 Duel → 🏛 Créer un salon), then:
//   npm run build && node tools/duel-bot.mjs ABCD [difficulty] [url]
// difficulty: easy | normal (default) | hard. url: a page of the game (default: dist/ served on :8899, which the
// relay admits as local development). The phone and this page must run the same duel code (__DUEL_HASH__): build
// from the commit the phone's app or page was built from.
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const [code, difficulty = "normal", urlArg] = process.argv.slice(2);
if (!/^[A-Za-z]{4}$/.test(code ?? "")) {
  console.error("usage: node tools/duel-bot.mjs ABCD [easy|normal|hard] [url]");
  process.exit(2);
}
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../dist");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".webp": "image/webp", ".json": "application/json", ".mp3": "audio/mpeg", ".mp4": "video/mp4", ".webmanifest": "application/manifest+json" };
let server = null;
if (!urlArg) {
  server = createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p.endsWith("/")) p += "index.html";
    const file = join(ROOT, p);
    if (!existsSync(file)) return void (res.writeHead(404), res.end("nf"));
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  });
  await new Promise((r) => server.listen(8899, r));
}
const page0 = new URL(urlArg ?? "http://localhost:8899/");
page0.searchParams.set("salon", code.toUpperCase());

const exe = ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((p) => existsSync(p));
const browser = await chromium.launch({
  executablePath: exe,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"]
});
// (small: the page draws in software, and must keep up with the lockstep)
const page = await browser.newPage({ viewport: { width: 640, height: 360 }, hasTouch: true });
const say = (m) => console.log(`[${new Date().toLocaleTimeString()}] ${m}`);
page.on("pageerror", (e) => say(`erreur de la page : ${e}`));
// (the intro seen first: the page drops ?salon= from its address at boot, so no reload after it)
const plain = new URL(page0.href);
plain.searchParams.delete("salon");
await page.goto(plain.href, { waitUntil: "networkidle" });
await page.evaluate(() => localStorage.setItem("panache.intro.seen", "1"));
await page.goto(page0.href, { waitUntil: "networkidle" });
say(`salon ${code.toUpperCase()} : on rejoint…`);

// the lobby: tap whatever moves it on (the title, Join, a nation, an opener), until the match runs
let last = "";
for (let i = 0; i < 600; i++) {
  const state = await page.evaluate(() => {
    const vis = (el) => !!el && el.getClientRects().length > 0 && !el.disabled;
    const tap = (sel) => {
      const el = [...document.querySelectorAll(sel)].find(vis);
      if (el) el.click();
      return !!el;
    };
    if (window.__bd?.world?.tick > 0 && !document.querySelector(".duel-body")) return "match";
    const status = document.querySelector(".duel-status, .duel-err")?.textContent?.trim() ?? "";
    if (tap('.op-card')) return "ouverture choisie";
    if (tap('[data-act="pick"]')) return "ouverture choisie";
    if (tap('[data-act="join"]')) return "rejoindre";
    if (tap('[data-act="nation"]')) return "nation";
    if (!document.querySelector(".duel-body")) document.body.click(); // (the title: « Touchez l'écran »)
    return status || "…";
  });
  if (state !== last) say(state);
  last = state;
  if (state === "match") break;
  await page.waitForTimeout(500);
}
if (last !== "match") {
  say("la partie n'a pas commencé (salon introuvable ? code faux ? versions différentes ?)");
  await browser.close();
  server?.close();
  process.exit(1);
}

// the match: the game's commander plays this page's side, one think per sim tick, through the page's own orders
await page.evaluate((diff) => {
  const bd = window.__bd;
  const ai = bd.ai.createAiState(undefined, diff);
  let seen = -1;
  setInterval(() => {
    const w = window.__bd.world;
    if (w.winner || w.tick === seen) return;
    seen = w.tick;
    for (const c of window.__bd.ai.tickAi(w, window.__bd.player, ai)) window.__bd.ctrl.enqueue(c);
  }, 50);
}, difficulty);
say(`l'IA (${difficulty}) joue ${await page.evaluate(() => window.__bd.player)}`);

for (;;) {
  await page.waitForTimeout(5000);
  const s = await page.evaluate(() => {
    const w = window.__bd?.world;
    if (!w) return null;
    const me = window.__bd.player;
    const mine = (m) => [...m.values()].filter((x) => x.faction === me).length;
    return { tick: w.tick, winner: w.winner ?? null, units: mine(w.units), buildings: mine(w.buildings), duel: window.__duel?.state ?? null };
  });
  if (!s) break;
  say(`${Math.floor(s.tick / 600)}:${String(Math.floor((s.tick / 10) % 60)).padStart(2, "0")} · ${s.units} unités, ${s.buildings} bâtiments${s.duel ? ` · ${s.duel}` : ""}`);
  if (s.winner) {
    say(s.winner === (await page.evaluate(() => window.__bd.player)) ? "l'IA a gagné" : s.winner === "draw" ? "match nul" : "tu as gagné");
    break;
  }
}
await page.waitForTimeout(3000);
await browser.close();
server?.close();
