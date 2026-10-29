// A sparring partner for the online duel, for playing one with no friend at hand: a headless page joins the
// lobby by its code, takes the nation and opener on offer, and plays its side with the game's own AI (the
// commander, as in a skirmish), every order going through the duel's lockstep like a player's tap.
//
// The phone hosts (🌐 Duel → 🏛 Créer un salon), then:
//   npm run build && node tools/duel-bot.mjs ABCD [difficulty] [url]
// Or a ranked match: `node tools/duel-bot.mjs classe [difficulty]` queues on the published relay (its own account,
// kept in the page) and the phone taps ⚔ Partie classée.
// difficulty: easy | normal (default) | hard. url: a page of the game (default: dist/ served on :8899, which the
// relay admits as local development). The phone and this page must run the same duel code (__DUEL_HASH__): build
// from the commit the phone's app or page was built from.
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const [code, difficulty = "normal", urlArg] = process.argv.slice(2);
const hosting = code === "heberge";
const ranked = hosting || /^class[ée]e?$/i.test(code ?? "");
if (!ranked && !/^[A-Za-z]{4}$/.test(code ?? "")) {
  console.error("usage: node tools/duel-bot.mjs ABCD|classe [easy|normal|hard] [url]");
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
if (!ranked) page0.searchParams.set("salon", code.toUpperCase());

const exe = ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((p) => existsSync(p));
const browser = await chromium.launch({
  executablePath: exe,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"]
});
// (small: the page draws in software, and must keep up with the lockstep)
const page = await browser.newPage({ viewport: { width: 640, height: 360 }, hasTouch: true });
const say = (m) => console.log(`[${new Date().toLocaleTimeString()}] ${m}`);
page.on("pageerror", (e) => say(`erreur de la page : ${e}`));
// (ranked: the account and the queue are the published relay's, which the game keeps from robots: this one is let in)
if (ranked) await page.addInitScript(() => Object.defineProperty(navigator, "webdriver", { get: () => false }));
// (the intro seen first: the page drops ?salon= from its address at boot, so no reload after it)
const plain = new URL(page0.href);
plain.searchParams.delete("salon");
await page.goto(plain.href, { waitUntil: "networkidle" });
await page.evaluate(() => {
  localStorage.setItem("panache.intro.seen", "1");
  localStorage.setItem("panache.portes", "toutes");
});
await page.goto(page0.href, { waitUntil: "networkidle" });
say(ranked ? "partie classée : en file…" : `salon ${code.toUpperCase()} : on rejoint…`);
if (ranked) {
  // the menu (the hub, without the robot flag): the Duel door opens the duel
  await page.waitForSelector('[data-door="duel"]', { state: "attached", timeout: 20_000 });
  await page.evaluate(() => document.querySelector('[data-door="duel"]').click());
  const act = hosting ? "host" : "ranked";
  await page.waitForSelector(`[data-act="${act}"]`, { state: "attached", timeout: 15_000 });
  await page.evaluate((a) => document.querySelector(`[data-act="${a}"]`).click(), act);
  if (hosting) {
    await page.waitForFunction(() => /^[A-Z]{4}$/.test(document.querySelector(".duel-bigcode")?.dataset.code ?? ""), null, { timeout: 15_000 });
    say(`salon ${await page.evaluate(() => document.querySelector(".duel-bigcode").dataset.code)}`);
  }
}

// the lobby: tap whatever moves it on (the title, Join, a nation, an opener), until the match runs.
// Real taps (pointer events, as a finger), the first visible of each in this order.
const STEPS = [
  [".op-card", "ouverture"],
  ['[data-act="pick"]', "ouverture"],
  ...(ranked ? [] : [['[data-act="join"]', "rejoindre"], ['[data-act="nation"]', "nation"]])
];
/** The page's answer, or "figée" if it doesn't give one in 10 s (busy loading, or hung). */
const ask = (fn, arg) => Promise.race([page.evaluate(fn, arg), new Promise((r) => setTimeout(() => r("figée"), 10_000))]);
let last = "";
let since = Date.now();
for (let i = 0; i < (ranked ? 3000 : 600); i++) {
  const state = await ask(() => {
    if (window.__bd?.world?.tick > 0 && !document.querySelector(".duel-body")) return "match";
    return document.querySelector(".duel-status, .duel-err")?.textContent?.trim() || (document.querySelector(".duel-body") ? "salon" : "titre");
  });
  if (state === "match") {
    say("match");
    last = state;
    break;
  }
  let tapped = "";
  if (state !== "figée") {
    for (const [sel, name] of STEPS) {
      const el = page.locator(sel).filter({ visible: true }).first();
      if (await el.count().catch(() => 0)) {
        await el.tap({ timeout: 3000 }).catch(() => el.click({ timeout: 3000 }).catch(() => undefined));
        tapped = name;
        break;
      }
    }
    if (!tapped && state === "titre") await page.mouse.click(320, 180);
  }
  const line = tapped ? `${state} → ${tapped}` : state;
  if (line !== last) {
    say(line);
    last = line;
    since = Date.now();
  } else if (Date.now() - since > 10_000) {
    // nothing moves: say what the page shows
    since = Date.now();
    const text = await ask(() => document.querySelector(".duel-body, .sheet, .op-cards, body")?.innerText?.replace(/\s+/g, " ").slice(0, 200));
    await page.screenshot({ path: "/tmp/duel-bot.png" }).catch(() => undefined);
    say(`toujours « ${line} » ; la page : ${text} (capture : /tmp/duel-bot.png)`);
  }
  await page.waitForTimeout(700);
}
if (last !== "match") {
  say("la partie n'a pas commencé (salon introuvable ? code faux ? versions différentes ?)");
  await browser.close();
  server?.close();
  process.exit(1);
}

// the match: the game's commander plays this page's side, one think per sim tick, through the page's own orders
// the HUD's messages (a ranked match's new rating), kept for the log
await page.evaluate(() => {
  window.__toasts = [];
  new MutationObserver((ms) => {
    for (const m of ms) for (const n of m.addedNodes) if (n instanceof HTMLElement && n.classList.contains("toast")) window.__toasts.push(n.textContent);
  }).observe(document.body, { childList: true, subtree: true });
});
// (PASSIF=1: the page sits still, for testing the link alone)
if (!process.env.PASSIF) await page.evaluate((diff) => {
  const bd = window.__bd;
  const ai = bd.ai.createAiState(undefined, diff);
  let seen = -1;
  setInterval(() => {
    const w = window.__bd.world;
    if (w.winner || w.tick === seen) return;
    seen = w.tick;
    // (the commander's difficulty sets its side's income in the world it's given: this world is the duel's, shared
    // with the other phone, so that is put back; only the orders go out)
    const f = w.factions[window.__bd.player];
    const income = f.incomeMult;
    const orders = window.__bd.ai.tickAi(w, window.__bd.player, ai);
    f.incomeMult = income;
    for (const c of orders) window.__bd.ctrl.enqueue(c);
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
  // (ABANDON=<s>: resign once the match has run that long, to end a test quickly)
  if (process.env.ABANDON && s.tick >= Number(process.env.ABANDON) * 10 && !s.winner) await page.evaluate(() => window.__bd.scene.feed?.duel?.resign(false));
  if (s.duel === "ended" && !s.winner) {
    await page.screenshot({ path: "/tmp/duel-bot.png" }).catch(() => undefined);
    say(`fin sans vainqueur : ${await page.evaluate(() => document.querySelector(".endscreen, .end, .hud-end, body")?.innerText?.replace(/\s+/g, " ").slice(0, 300))}`);
    say(`résultat : ${JSON.stringify(await page.evaluate(() => window.__duel?.result))}`);
    break;
  }
  if (s.winner) {
    await page.waitForTimeout(8000);
    const toasts = await page.evaluate(() => window.__toasts ?? []);
    if (toasts.length) say(`messages : ${toasts.join(" / ")}`);
    say(s.winner === (await page.evaluate(() => window.__bd.player)) ? "l'IA a gagné" : s.winner === "draw" ? "match nul" : "tu as gagné");
    break;
  }
}
await page.waitForTimeout(3000);
await browser.close();
server?.close();
