// Duel smoke (DUEL.md "Dev and test modes"): two pages of the built app,
// one browser context each, play a duel through the relay
// (?duel=relay, src/versus/relay-transport.ts) instead of the air. Node is
// the air between them: each page's window.__duelOut hands its packets here,
// and they reach the other page's window.__duelIn after a seeded delay
// (--latency ms plus up to --jitter ms, in order, as sound arrives), with
// seeded Bernoulli loss (--loss) and one outage of --outage ms one way.
//
//   1. The lobby by hand: both pages at ?duel=relay, Duel, then Host on one
//      and Join on the other. They pair (the host's map and mutators, blue
//      and red) and show the opener cards; both Cancel and get the menu back.
//   2. The match: ?duel=relay&seat=host and &seat=guest pair at once. Each
//      taps an opener card, the match loads, and from then on the pages are
//      advanced with __bd.scene.step(): a hidden page gets no animation
//      frames, so nothing here waits on them. (Each page's own frames are
//      held to one every RAF_MS, and once the match is up the scene draws
//      none: the two pages share one software renderer, and drawing at full
//      rate starves both to a tick or two a second.)
//      Orders (a build bar button, moves through the Controller), the outage
//      (both stall, "Waiting for your friend…", then go on), a pause (the
//      friend stalls within D ticks: "Friend paused"), then, past tick
//      MATCH_TICKS, the guest resigns from the pause menu.
//      Both must decide on the same tick with the same world hash and hash
//      trail (compared at every tick of the match), show the report
//      (VICTORY / DEFEAT, "Sync OK ✓", "Practice link") and save
//      the same battle (Save battle: turns and the hash every 100 ticks).
//      No win/loss record is written on a practice link.
//   3. Rematch: the host taps Rematch and reconnects from the reloaded page;
//      the guest, still on its report, shows "Your friend is back in the
//      lobby: tap Rematch", taps it and reconnects. They pair in the same
//      roles with the sides swapped, and both Cancel.
//
// Fails on any console error. Prints "DUEL SMOKE OK".
// Usage: node tools/duel-smoke.mjs [--seed=1] [--loss=0.1] [--latency=120] [--jitter=80] [--outage=2500] [--shots] [url]
// (serves dist/: run `npm run build` first; SMOKE_SHOT_DIR for --shots, default /tmp)
//
// Where the spec is silent:
//  - the relay's delay never reorders packets (sound arrives in order), and
//    the seed fixes the loss and delay draws, not the match: each page draws
//    its pairing nonces from crypto, so the map seed differs run to run;
//  - Host / Join is driven on pages without a seat (a seat pairs at once, so
//    its lobby has no role to tap), then the match runs on seated pages;
//  - each page's own animation frames are slowed to one every RAF_MS by an
//    init script (the boot waits for one), and once both matches are up the
//    scene's own frame loop is stopped (cancelAnimationFrame(scene.raf)):
//    the smoke steps the scene undrawn (__bd.scene.step(100, 1, false)),
//    drawing only for --shots. Each frame the scene drew held its page's main
//    thread 1–2.5 s, a third to a half of the match, in which the page
//    neither stepped nor sent a packet;
//  - the hash trails are compared at every tick of the match, from each
//    page's own log (window.__duel.trails: read from outside after each step,
//    the trail missed every tick a step took two of, which a lossy link's
//    stalls make common), on top of the lockstep's own checkpoints and end
//    check, the final world hash and the saved battles' hash every 100 ticks;
//  - "Friend paused" may take the friend D more ticks and 0.5 s of stall to
//    show: it is waited for as long as the progress checks allow those;
//  - "the match goes on" (at the start, after the outage, after the pause)
//    means both pages step 2D + 1 more ticks: more than D proves the friend's
//    new turns arrived (a phone holds at most D of them ahead), twice over.
//    How long that takes is the link's business (latency, loss, D) and the
//    smoke's (two pages on one renderer), so the checks follow them: a page
//    held on one tick for STUCK_MS fails (a stall that never ends, a stuck
//    page), and so does a match slower on average than TICK_MS a tick (one
//    that crawls), where a slow link passes;
//  - a page whose main thread is blocked for BLOCKED_MS or more at a
//    stretch has stopped, not the link: a heartbeat in each page (every
//    BEAT_MS) logs such gaps, and the waits leave out the time either page
//    stopped, but not while the relay cut either way (a cut holds the
//    pages up whatever they do). On a loaded machine (load average 8–14 on
//    4 CPUs) a page went 9 s without running a script (the shared software
//    renderer), sending nothing, and its friend, held that long on its tick,
//    failed STUCK_MS; the page that stops is held as long, once its friend
//    has stepped through the turns it had. Shorter blocks are the smoke's
//    own pace, which the thresholds allow for: undrawn, a page still stops
//    for 1–2.5 s now and then (more while a stall overlay is up), and
//    leaving those out too let a 10 s cut of the relay pass, as did leaving
//    out the drawn frames. Each progress line says how long the pages
//    stopped;
//  - once a progress check has failed, the match is cut short: the trail
//    check says where it ended, and the saved battle isn't held to a full
//    match's turns and hashes;
//  - the build bar's Fab button gets its click straight (dispatchEvent), not
//    Playwright's tap: that first waits for the button to hold still over
//    two animation frames (1–3 s here, 6–19 s on a loaded machine), and in one
//    run of many the host's Fab then never landed in either world, for no
//    reason the smoke could tell. The touch is the build bar's own, the same
//    in single player (tools/smoke.mjs); here it is the order's way from the
//    button to both worlds that counts. Each click must put the order on its
//    way at once, and a Fab that doesn't land prints both pages' Controller
//    and lockstep queues, so a lost order is told from a missed tap;
//  - "both matches are up" waits, past the match state, for each page's
//    first frame on screen (a screenshot of a few pixels), as the timed
//    checks start there. The first composite after the match loads can take
//    15 s here (the scene has just compiled its shaders, and the two pages
//    share one software renderer), and a page that repaints meanwhile is
//    held, outside its scripts. Without the wait the match state came first
//    in 3 runs of 8, and both pages were then held 7–12 s just after the Fab
//    clicks; in 2 of them the guest was 5 ticks on at the Fab check, its own
//    order not yet stepped;
//  - --shots waits for the cards' and the report's entrance animations (CSS:
//    the slowed frames don't hold them) and takes the screenshot with any
//    finite one left fast-forwarded, so nothing is caught mid-way.
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
const args = process.argv.slice(2);
const opt = (name, def) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? Number(a.slice(name.length + 3)) : def;
};
const SEED = opt("seed", 1);
const LOSS = opt("loss", 0.1);
const LATENCY = opt("latency", 120);
const JITTER = opt("jitter", 80);
const OUTAGE = opt("outage", 2500);
const shots = args.includes("--shots");
/** The host's mutator (DUEL_MUTATOR, default Lightning Production), as the lobby names it. */
const MUT_NAME = { rapidfab: "Lightning Production", eclair: "Lightning Match" }[process.env.DUEL_MUTATOR ?? "rapidfab"] ?? ".";
const urlArg = args.find((a) => !a.startsWith("--"));
/** Each page's animation frames come this far apart (ms): see 2. above. */
const RAF_MS = 4000;
/** Each page's heartbeat (ms), and the gap in it that counts as its page stopped (see the header). */
const BEAT_MS = 50;
const BLOCKED_MS = 3000;
/** The match goes on to this tick before the resign: the saved battle has a world hash every 100. */
const MATCH_TICKS = 320;
for (const [k, v] of Object.entries({ seed: SEED, loss: LOSS, latency: LATENCY, jitter: JITTER, outage: OUTAGE }))
  if (!Number.isFinite(v) || v < 0) throw new Error(`--${k} must be a number ≥ 0`);
if (LOSS >= 1) throw new Error("--loss must be below 1");
/**
 * The most a page may be held on one tick with nothing wrong (ms): the
 * smoke's own 6 s (two pages on one machine, stepped from here a pair of
 * frames at a time), the turn's trip and its ack's (LATENCY +
 * JITTER each way), and a robust packet period (200 ms) for each loss in a
 * row the relay's draws can make: k in a row has odds LOSS^k at a packet, so
 * one in a million allows log(1e-6) / log(LOSS) of them. Time a page
 * stopped doesn't count (see the header).
 */
const LOSS_RUN = LOSS > 0 ? Math.ceil(Math.log(1e-6) / Math.log(LOSS)) : 0;
const STUCK_MS = 6000 + 2 * (LATENCY + JITTER) + 200 * LOSS_RUN;
/**
 * The most a tick may take on average over a progress check (ms), at input
 * delay D: the link's share (a turn's trip with that run of losses, spread
 * over the D turns a phone holds ahead) and the smoke's (two steps of a page
 * every 400 ms or so, at the slowest seen; about 3 ticks a second is usual).
 */
const tickMs = (D) => (LATENCY + JITTER + 200 * LOSS_RUN) / D + 400;

let server = null;
if (!urlArg) {
  if (!existsSync(join(ROOT, "index.html"))) throw new Error("no dist/index.html: run `npm run build` first");
  server = createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p.endsWith("/")) p += "index.html";
    const file = join(ROOT, p);
    if (!existsSync(file)) { res.writeHead(404); res.end("nf"); return; }
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  });
  await new Promise((r) => server.listen(8897, r));
}
const base = new URL(urlArg ?? "http://localhost:8897/");
const urlFor = (seat) => {
  const u = new URL(base);
  u.searchParams.set("duel", "relay");
  if (seat) u.searchParams.set("seat", seat);
  return u.href;
};

let failed = false;
const fail = (msg) => { console.error(`FAIL: ${msg}`); failed = true; process.exitCode = 1; };
const check = (ok, msg) => { if (!ok) fail(msg); return ok; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)} s] ${msg}`);
const T0 = Date.now();

/** mulberry32: the relay's loss and delay draws. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------ the air ---

/**
 * The relay between the two pages: what one page's __duelOut sends reaches the
 * other's __duelIn after LATENCY + jitter ms (never overtaking the packet
 * before it), unless the loss draw or an outage drops it. Each direction has
 * its own seeded draws.
 */
class Air {
  constructor(seed) {
    this.ends = new Map();
    this.dirs = new Map();
    this.seed = seed;
    this.timer = setInterval(() => this.deliver(), 10);
  }
  /** One page, as `name`, whose packets go to `to`. */
  async attach(name, to, page) {
    const dir = { from: name, to, rand: rng(this.seed * 2 + this.dirs.size + 1), queue: [], last: 0, busy: false, sent: 0, lost: 0, delivered: 0, cutUntil: 0, cuts: [], sentAt: 0, deliveredAt: 0 };
    this.dirs.set(name, dir);
    this.ends.set(name, page);
    await page.exposeFunction("__duelOut", (b64, nbits) => this.send(name, b64, nbits));
  }
  send(from, b64, nbits) {
    const d = this.dirs.get(from);
    const now = Date.now();
    d.sent++;
    d.sentAt = now;
    // (draw both always, so the pattern doesn't depend on the outage)
    const lost = d.rand() < LOSS;
    const at = Math.max(d.last, now + LATENCY + d.rand() * JITTER);
    if (lost || now < d.cutUntil) return void d.lost++;
    d.last = at;
    d.queue.push({ at, b64, nbits });
  }
  /** Drop everything `from` sends for `ms`. */
  cut(from, ms) {
    const d = this.dirs.get(from);
    d.cutUntil = Date.now() + ms;
    d.cuts.push([Date.now(), d.cutUntil]);
  }
  deliver() {
    const now = Date.now();
    for (const d of this.dirs.values()) {
      if (d.busy) continue;
      let n = 0;
      while (n < d.queue.length && d.queue[n].at <= now) n++;
      if (!n) continue;
      const due = d.queue.splice(0, n).map((p) => [p.b64, p.nbits]);
      const page = this.ends.get(d.to);
      d.busy = true;
      // (no __duelIn yet, or a page reloading: lost, as on the air)
      page
        .evaluate((list) => {
          for (const [b, n] of list) window.__duelIn?.(b, n);
        }, due)
        .then(() => ((d.delivered += due.length), (d.deliveredAt = Date.now())), () => undefined)
        .finally(() => (d.busy = false));
    }
  }
  stats() {
    return [...this.dirs.values()].map((d) => `${d.from}→${d.to} ${d.sent} sent, ${d.lost} lost, ${d.delivered} delivered`).join("; ");
  }
  /** What each direction did lately: a held page is the link's (nothing sent or delivered) or the page's. */
  recent() {
    const now = Date.now();
    return [...this.dirs.values()]
      .map((d) => `${d.from}→${d.to}: last sent ${now - d.sentAt} ms ago, last delivered ${now - d.deliveredAt} ms ago, ${d.queue.length} queued${d.busy ? ", delivering" : ""}`)
      .join("; ");
  }
  close() {
    clearInterval(this.timer);
  }
}

// ---------------------------------------------------------- the pages ---

const exe = ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((p) => existsSync(p));
const browser = await chromium.launch({
  executablePath: exe,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"]
});
/** Each phone's menu: the host offers its map and mutators; the guest's own picks must not matter. */
const SETTINGS = {
  host: { mapId: "riverlands", difficulty: "normal", mode: "skirmish", mutators: [process.env.DUEL_MUTATOR ?? "rapidfab"] },
  guest: { mapId: "frostbite", difficulty: "normal", mode: "skirmish", mutators: [] }
};
const air = new Air(SEED);
const phones = {};
for (const name of ["host", "guest"]) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, hasTouch: true, acceptDownloads: true, locale: "en-US" });
  // (the page's own frames, slowed: the smoke steps the game itself)
  await context.addInitScript((ms) => {
    window.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), ms);
    window.cancelAnimationFrame = (id) => clearTimeout(id);
  }, RAF_MS);
  // (the heartbeat: the spans the page's main thread was blocked for BLOCKED_MS or more, on the wall clock the pages and
  // Node share; and the one it is coming out of, which the beat that ends it may not have logged yet)
  await context.addInitScript(([beat, over]) => {
    const spans = [];
    let last = Date.now();
    setInterval(() => {
      const now = Date.now();
      if (now - last > over) {
        spans.push([last + beat, now]);
        if (spans.length > 256) spans.shift();
      }
      last = now;
    }, beat);
    window.__blockedSpans = () => (Date.now() - last > over ? [...spans, [last + beat, Date.now()]] : spans.slice());
  }, [BEAT_MS, BLOCKED_MS]);
  await context.addInitScript((s) => {
    try {
      localStorage.setItem("panache.settings", s);
    } catch {
      /* ignore */
    }
  }, JSON.stringify(SETTINGS[name]));
  const page = await context.newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(`${name}: ${m.text()}`); });
  page.on("pageerror", (e) => errors.push(`${name}: ${String(e)}`));
  phones[name] = { name, context, page, errors, trail: new Map(), seen: -1, tick: -1 };
}
await air.attach("host", "guest", phones.host.page);
await air.attach("guest", "host", phones.guest.page);
const both = (fn) => Promise.all([fn(phones.host), fn(phones.guest)]);
/**
 * A screenshot (--shots), the battlefield drawn first. The opener cards and
 * the report come in with CSS animations: it waits up to 5 s for the finite
 * ones to finish, and the screenshot fast-forwards any still running.
 */
const shot = async (p, label) => {
  if (!shots) return;
  await p.page.evaluate(() => window.__bd?.scene?.step(0, 1)).catch(() => undefined);
  await p.page
    .waitForFunction(
      () => document.getAnimations().every((a) => a.playState !== "running" || a.effect?.getComputedTiming().iterations === Infinity),
      null,
      // (polled by timer: the page's animation frames are slowed)
      { timeout: 5000, polling: 100 }
    )
    .catch(() => undefined);
  await p.page.screenshot({ path: `${SHOT_DIR}/duel-${label}-${p.name}.png`, animations: "disabled" });
};
/** The text of the first element `sel` finds now ("" if none: no waiting for it). */
const text = (p, sel) => p.page.evaluate((q) => document.querySelector(q)?.innerText ?? "", sel).catch(() => "");

/** The Duel button on the menu, once its chunk is in (Skirmish tab). */
async function tapDuel(p) {
  await p.page.waitForSelector("#play-online:not([disabled])", { timeout: 30000 });
  await p.page.locator("#play-online").tap();
  await p.page.waitForSelector(".duelsheet", { timeout: 10000 });
}

/** Wait for the opener cards (paired) and read the paired line and the map line. */
async function paired(p) {
  await p.page.waitForSelector(".duel-cards .op-card", { timeout: 45000 });
  return { line: await text(p, ".duel-paired"), map: await text(p, ".duel-map"), muts: await text(p, ".duel-muts") };
}

/** Cancel the lobby: the sheet goes, and the Duel button comes back. */
async function cancel(p) {
  await p.page.locator(".duelsheet [data-act=cancel]").tap();
  await p.page.waitForSelector(".duel-wrap", { state: "detached", timeout: 10000 });
  await p.page.waitForSelector("#play-online:not([disabled])", { timeout: 10000 });
}

// --------------------------------------------------- 1. the lobby by hand ---

log("1. the lobby: Host and Join");
await both((p) => p.page.goto(urlFor(null), { waitUntil: "networkidle" }));
check((await both((p) => p.page.evaluate(() => document.visibilityState))).every((v) => v === "visible"), "a page isn't visible: its frames would say paused");
await both(tapDuel);
check(await phones.host.page.locator(".duel-practice").isVisible(), "the lobby doesn't say it's a practice link");
await phones.host.page.locator(".duel-role[data-act=host]").tap();
await phones.guest.page.locator(".duel-role[data-act=join]").tap();
{
  const [h, g] = await both(paired);
  log(`paired: host "${h.line}", guest "${g.line}"`);
  check(/you play blue/i.test(h.line) && /you play red/i.test(g.line), `sides: host "${h.line}", guest "${g.line}"`);
  check(/River Lands/.test(h.map) && h.map === g.map, `the map: host "${h.map}", guest "${g.map}" (the host's River Lands)`);
  check(new RegExp(MUT_NAME).test(h.muts) && h.muts === g.muts, `the mutators: host "${h.muts}", guest "${g.muts}" (the host's ${MUT_NAME})`);
  // (each card says what its opener gives, as the single-player picker does)
  const gives = await phones.host.page.locator(".duel-cards .op-card .op-gives").allInnerTexts();
  check(gives.length > 0 && gives.every((t) => / · \d+ Steam Wagons/.test(t)), `the cards don't say what each opener gives: ${JSON.stringify(gives)}`);
  await both((p) => shot(p, "1-paired"));
}
await both(cancel);

// ----------------------------------------------------------- 2. the match ---

log("2. the match: seats");
await phones.host.page.goto(urlFor("host"), { waitUntil: "networkidle" });
await phones.guest.page.goto(urlFor("guest"), { waitUntil: "networkidle" });
await both(tapDuel);
// (a seat pairs at once: no Host / Join)
check((await phones.host.page.locator(".duel-role").count()) === 0, "a seat page offered Host / Join");
await both(paired);
const picks = {};
for (const p of [phones.host, phones.guest]) {
  const ids = await p.page.locator(".duel-cards .op-card").evaluateAll((els) => els.map((e) => e.dataset.id));
  picks[p.name] = p.name === "host" ? ids[0] : ids[ids.length - 1];
  await p.page.locator(`.duel-cards .op-card[data-id="${picks[p.name]}"]`).tap();
}
log(`picks: host ${picks.host}, guest ${picks.guest}`);
await both((p) => p.page.waitForFunction(() => window.__bd?.scene && window.__duel?.state === "match", null, { timeout: 90000 }));
// (and on screen, one page at a time: see the header)
{
  const took = {};
  for (const p of [phones.host, phones.guest]) {
    const t = Date.now();
    await p.page.screenshot({ clip: { x: 0, y: 0, width: 4, height: 4 }, timeout: 90000 });
    took[p.name] = ((Date.now() - t) / 1000).toFixed(1);
  }
  log(`both matches are up, on screen after host ${took.host} s, guest ${took.guest} s`);
  // (and drawn no more but for --shots: see the header)
  await both((p) => p.page.evaluate(() => cancelAnimationFrame(window.__bd.scene.raf)));
}

const player = async (p) => p.page.evaluate(() => window.__bd.player);
check((await player(phones.host)) === "blue" && (await player(phones.guest)) === "red", "the host plays blue and the guest red");
{
  const w = await both((p) => p.page.evaluate(() => ({ map: window.__bd.world.mapId, rules: JSON.stringify(window.__bd.world.rules ?? null) })));
  check(w[0].map === "riverlands" && w[1].map === "riverlands", `both play the host's map: ${JSON.stringify(w)}`);
  check(w[0].rules === w[1].rules && w[0].rules !== "null", `both play the host's mutators: ${JSON.stringify(w)}`);
}
check((await phones.host.page.locator(".duel-wrap").count()) === 0, "the lobby sheet stayed up into the match");

/** The hash trail after every tick a page stepped (its own log, read as it grows): both pages must agree at every tick. */
const sample = (p, r) => {
  if (!r) return;
  p.tick = r.tick;
  for (const [tick, trail] of r.trails) {
    p.trail.set(tick, trail);
    p.seen = Math.max(p.seen, tick);
  }
};
/**
 * Two frames of 100 ms on each page in a match, undrawn (the lockstep holds
 * them to the turns that have arrived), then its tick and the trail of the
 * ticks stepped since the last look. A page on the menu or reloading is left
 * alone.
 */
const stepBoth = () =>
  both((p) =>
    p.page
      .evaluate((from) => {
        if (!window.__bd?.scene || !window.__duel) return null;
        for (let i = 0; i < 2; i++) window.__bd.scene.step(100, 1, false);
        return { tick: window.__duel.tick, trails: window.__duel.trails(from) };
      }, p.seen + 1)
      .then((r) => sample(p, r), () => undefined)
  );
/** The spans (Date.now()) a page's main thread was blocked for BLOCKED_MS or more, from its heartbeat. */
const blockedSpans = (p) => p.page.evaluate(() => window.__blockedSpans?.() ?? []).catch(() => []);
/** How long since `from` the spans cover, merged, less the `minus` spans. */
function covered(spans, from, minus = []) {
  const now = Date.now();
  const merge = (list) => {
    const out = [];
    for (const [a, b] of list.map(([a, b]) => [Math.max(a, from), Math.min(b, now)]).filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0])) {
      const last = out[out.length - 1];
      if (last && a <= last[1]) last[1] = Math.max(last[1], b);
      else out.push([a, b]);
    }
    return out;
  };
  const less = merge(minus);
  let total = 0;
  for (const [a, b] of merge(spans)) {
    total += b - a;
    for (const [c, d] of less) total -= Math.max(0, Math.min(b, d) - Math.max(a, c));
  }
  return total;
}
/** How long since `from` either page stopped, outside the relay's cuts (see the header). */
const blocked = async (from) => covered((await both(blockedSpans)).flat(), from, [...air.dirs.values()].flatMap((d) => d.cuts));
const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;
/** Advance both pages for `ms` of time they could run (the link sets the pace; see the header for the blocked time). */
async function run(ms, until = null) {
  const T = Date.now();
  for (;;) {
    await stepBoth();
    if (until && (await until())) return true;
    if (Date.now() - T >= ms && Date.now() - T - (await blocked(T)) >= ms) return false;
    await sleep(30);
  }
}
const tick = (p) => p.page.evaluate(() => window.__duel.tick);
const ticks = () => both(tick);

/**
 * Step both pages until each is `n` ticks past where it is now (see the
 * header). False, and a failure saying `what`, if a page short of its mark is
 * held on one tick for STUCK_MS, or it all takes longer than n ticks of
 * tickMs(D) after that, neither counting the time a page stopped (see the
 * header).
 */
async function goesOn(what, n) {
  const from = await ticks();
  const held = from.map(() => Date.now());
  const last = from.slice();
  const T = Date.now();
  const limit = STUCK_MS + n * tickMs(D);
  for (;;) {
    await stepBoth();
    const now = [phones.host.tick, phones.guest.tick];
    if (now.every((t, i) => t >= from[i] + n)) {
      const b = await blocked(T);
      log(`${what}: host ${from[0]} → ${now[0]}, guest ${from[1]} → ${now[1]} in ${secs(Date.now() - T)}${b ? ` (pages stopped ${secs(b)})` : ""}`);
      return true;
    }
    if (Date.now() - T > limit) {
      const b = await blocked(T);
      if (Date.now() - T - b > limit)
        return progressFailed(`${what}: ${n} ticks took over ${secs(limit)} (host ${from[0]} → ${now[0]}, guest ${from[1]} → ${now[1]}, D ${D}; pages stopped ${secs(b)} besides)`);
    }
    for (const i of [0, 1]) {
      if (now[i] !== last[i]) [last[i], held[i]] = [now[i], Date.now()];
      else if (now[i] < from[i] + n && Date.now() - held[i] > STUCK_MS) {
        const b = await blocked(held[i]);
        if (Date.now() - held[i] - b <= STUCK_MS) continue;
        const pages = await both((p) =>
          p.page
            .evaluate(() => `${document.visibilityState}, ${window.__bd?.ctrl?.paused ? "paused" : "playing"}, "${document.querySelector(".duel-stall:not([hidden])")?.innerText ?? ""}"`)
            .catch((e) => String(e))
        );
        return progressFailed(
          `${what}: the ${i ? "guest" : "host"} was held on tick ${now[i]} for ${STUCK_MS} ms, pages stopped ${secs(b)} besides (host ${from[0]} → ${now[0]}, ` +
            `guest ${from[1]} → ${now[1]}, D ${D}; host ${pages[0]}, guest ${pages[1]}; ${air.recent()})`
        );
      }
    }
    await sleep(30);
  }
}
/** A progress check failed: the match will be cut short (see the header). */
let cutShort = false;
const progressFailed = (msg) => {
  cutShort = true;
  return check(false, msg);
};

/** The input delay the pairing agreed: the progress checks ask for 2D + 1 ticks. */
const D = await phones.host.page.evaluate(() => window.__duel.delay);
check(D >= 3 && D <= 8 && D === (await phones.guest.page.evaluate(() => window.__duel.delay)), `the input delay: ${D}`);
log(`D ${D}; a page held on one tick for ${STUCK_MS} ms fails, as do ${tickMs(D).toFixed(0)} ms a tick on average`);
await goesOn("the match goes on", 2 * D + 1);
// the openers both picked are in both worlds
{
  const kinds = await both((p) => p.page.evaluate(() => [...window.__bd.world.buildings.values()].map((b) => `${b.faction}:${b.kind}`).sort().join(",")));
  check(kinds[0] === kinds[1], `the buildings differ: host ${kinds[0]} / guest ${kinds[1]}`);
}

// orders: a build bar tap on each phone (real taps, once it has the scrap), and a move through the Controller
const btn = (p, name) => p.page.locator(".bb", { has: p.page.locator(".nm", { hasText: new RegExp(`^${name}$`) }) });
const rich = await run(30000, async () =>
  (await both((p) => p.page.evaluate(() => window.__bd.world.factions[window.__bd.player].scrap >= 300 && !window.__bd.world.factions[window.__bd.player].pending))).every(Boolean)
);
check(rich, "no scrap for a Fab Plant after 30 s");
/** Each side's Fab Plants, built or under construction (an opener may have brought one). */
const fabs = (p) =>
  p.page.evaluate(() => {
    const w = window.__bd.world;
    const n = (f) => [...w.buildings.values()].filter((b) => b.faction === f && b.kind === "fab-plant").length + (w.factions[f].pending?.kind === "fab-plant" ? 1 : 0);
    return { blue: n("blue"), red: n("red") };
  });
/** Where a page's own orders are: the Controller's queue and in flight, the build slot, toasts, and the lockstep's queue. */
const orders = (p) =>
  p.page
    .evaluate(() => {
      const { world: w, ctrl, player: me, scene } = window.__bd;
      const ls = scene.feed?.session?.lockstep?.status();
      const card = document.querySelector("#card");
      return {
        tick: w.tick,
        queue: (ctrl.queue ?? []).map((c) => c.type),
        inFlight: (ctrl.inFlight ?? []).map((c) => c.type),
        pending: w.factions[me].pending?.kind ?? null,
        scrap: Math.round(w.factions[me].scrap),
        card: card ? !card.hidden : null,
        toasts: [...document.querySelectorAll(".toast .tx")].map((t) => t.textContent),
        lockstep: ls && { tick: ls.tick, queued: ls.queued, queuedTicks: ls.queuedTicks, newestSealed: ls.newestSealed, ackThrough: ls.ackThrough, peerAck: ls.peerAck, stalled: ls.stalled }
      };
    })
    .catch((e) => String(e));
const fabsBefore = await fabs(phones.host);
for (const p of [phones.host, phones.guest]) {
  await btn(p, "Forges").dispatchEvent("click");
  // (on its way: in the Controller's queue until the next step drains it, then in flight, or already the build slot's)
  const o = await orders(p);
  check(o.queue?.includes("startBuilding") || o.inFlight?.includes("startBuilding") || o.pending === "fab-plant", `the ${p.name}'s Fab tap made no order: ${JSON.stringify(o)}`);
}
const moved = {};
for (const p of [phones.host, phones.guest])
  moved[p.name] = await p.page.evaluate(() => {
    const { world: w, ctrl, player: me } = window.__bd;
    const ids = [...w.units.values()].filter((u) => u.faction === me && u.kind !== "harvester").map((u) => u.id);
    if (ids.length) ctrl.enqueue({ type: "move", faction: me, unitIds: ids, x: w.width / 2, y: w.height / 2 });
    return ids;
  });
log(`orders: Fab on both, moves for ${moved.host.length} host and ${moved.guest.length} guest units`);
await run(4000);
// (both phones' worlds have both sides' Fab Plants; the saved battle below has the orders as stepped)
for (const p of [phones.host, phones.guest]) {
  const now = await fabs(p);
  if (!check(now.blue > fabsBefore.blue && now.red > fabsBefore.red, `the Fab taps didn't land on the ${p.name}'s phone: ${JSON.stringify(fabsBefore)} → ${JSON.stringify(now)}`))
    log(`orders: host ${JSON.stringify(await orders(phones.host))}; guest ${JSON.stringify(await orders(phones.guest))}`);
}
await both((p) => shot(p, "2-match"));

// the outage: the host's packets don't reach the guest for OUTAGE ms
if (OUTAGE > 0) {
  log(`outage: host→guest cut for ${OUTAGE} ms`);
  air.cut("host", OUTAGE);
  let waited = false;
  await run(OUTAGE, async () => {
    if (!waited) waited = /Waiting for your friend/.test(await text(phones.guest, ".duel-stall:not([hidden])"));
    return false;
  });
  check(OUTAGE < 1500 || waited, "the guest didn't show \"Waiting for your friend…\" in the outage");
  await goesOn("after the outage", 2 * D + 1);
}

// pause: the host pauses; the guest stalls within D ticks and says so
log("pause");
await phones.host.page.locator("#btn-menu").tap();
check(await phones.host.page.evaluate(() => window.__bd.ctrl.paused), "the pause button didn't pause");
const pauseLine = await text(phones.host, "#pause .time");
check(/vs your friend · 🔊 \d+ ms/.test(pauseLine) && Number(/🔊 (\d+) ms/.exec(pauseLine)?.[1]) === D * 100, `the pause line: "${pauseLine}" (D ${D})`);
check((await phones.host.page.locator("#p-resign").count()) === 1, "no Resign in the pause menu");
check((await phones.host.page.locator("#p-quit, #p-fog").count()) === 0, "the duel's pause menu offers Quit or the fog toggle");
await shot(phones.host, "3-paused");
const hostAt = await tick(phones.host);
// (the friend steps on through the turns it holds, up to D past the pause, and says so once its stall is 0.5 s
// old: how long that takes follows the link, as the progress checks do)
const pausedT = Date.now();
const friendPaused = await run(STUCK_MS + (D + 1) * tickMs(D), async () => /friend paused/i.test(await text(phones.guest, ".duel-stall:not([hidden])")));
const pausedAfter = (Date.now() - pausedT) / 1000;
const [hostHeld, guestHeld] = await ticks();
await run(1000);
const [, guestHeld2] = await ticks();
log(`paused at host tick ${hostAt} (D ${D}): host ${hostHeld}, guest ${guestHeld} → ${guestHeld2}, "Friend paused" after ${pausedAfter.toFixed(1)} s`);
check(hostHeld === hostAt, "the paused phone stepped on");
check(guestHeld2 === guestHeld && guestHeld <= hostAt + D + 1, `the friend didn't stall within D ticks of the pause (${guestHeld2} vs ${hostAt} + ${D})`);
check(friendPaused, "the friend didn't show \"Friend paused\"");
await shot(phones.guest, "3-friend-paused");
await phones.host.page.locator("#p-resume").tap();
await goesOn("after the pause", 2 * D + 1);

// more orders, then the guest resigns from the pause menu
for (const p of [phones.host, phones.guest])
  await p.page.evaluate(() => {
    const { world: w, ctrl, player: me } = window.__bd;
    const ids = [...w.units.values()].filter((u) => u.faction === me && u.kind !== "harvester").map((u) => u.id);
    if (ids.length) ctrl.enqueue({ type: "attackMove", faction: me, unitIds: ids, x: w.width / 2, y: w.height / 2 });
  });
{
  const [h, g] = await ticks();
  await goesOn(`on to tick ${MATCH_TICKS}`, MATCH_TICKS - Math.min(h, g));
}
log("the guest resigns");
await phones.guest.page.locator("#btn-menu").tap();
await phones.guest.page.locator("#p-resign").tap();
await phones.guest.page.locator("#p-yes").tap();
check(!(await phones.guest.page.evaluate(() => window.__bd.ctrl.paused)), "the pause menu stayed up after Resign");
const decided = await run(30000, async () => {
  const r = await both((p) => p.page.evaluate(() => window.__duel.result?.tick ?? null));
  return r.every((t) => t !== null);
});
check(decided, "the resign didn't decide both matches");
// the finale, then the report: step on until both show it
const reported = await run(60000, async () => (await both((p) => p.page.locator("#again").isVisible())).every(Boolean));
check(reported, "the report didn't show on both phones");
// the end check: "Sync OK ✓" on both
const synced = await run(15000, async () => (await both((p) => text(p, ".duel-sync"))).every((t) => /Sync OK/.test(t)));
{
  const res = await both((p) => p.page.evaluate(() => window.__duel.result));
  const end = await both((p) => p.page.evaluate(() => ({ tick: window.__duel.tick, trail: window.__duel.trail(), hash: window.__duel.hash() })));
  log(`results: ${JSON.stringify(res)}`);
  log(`ends: ${JSON.stringify(end)}`);
  for (const r of res) check(r && r.winner === "blue" && r.resigned === "red" && !r.desync, `the result: ${JSON.stringify(r)}`);
  check(res[0]?.tick === res[1]?.tick, "the two phones decided on different ticks");
  check(end[0].tick === end[1].tick && end[0].hash === end[1].hash && end[0].trail === end[1].trail, "the two worlds differ at the end");
  check(synced && res.every((r) => r?.endCheck === "ok"), `the end check: ${JSON.stringify(res.map((r) => r?.endCheck))}`);
}
// the hash trail at every tick of the match, through the deciding one, on both pages
{
  await stepBoth();
  const last = await phones.host.page.evaluate(() => window.__duel.result?.tick ?? -1);
  const missing = [];
  const differ = [];
  for (let t = 0; t <= last; t++) {
    if (!phones.host.trail.has(t) || !phones.guest.trail.has(t)) missing.push(t);
    else if (phones.host.trail.get(t) !== phones.guest.trail.get(t)) differ.push(t);
  }
  log(`trails: ${phones.host.trail.size} host and ${phones.guest.trail.size} guest ticks, compared through tick ${last}`);
  check(last >= MATCH_TICKS, `the match was decided at tick ${last}, before tick ${MATCH_TICKS}${cutShort ? ": a progress check failed above" : ""}`);
  check(missing.length === 0, `ticks with no trail on a page (through ${last}): ${missing.slice(0, 10).join(", ")}`);
  check(differ.length === 0, `the hash trails differ at ticks ${differ.slice(0, 10).join(", ")}`);
}
// the report
{
  const heads = await both((p) => text(p, ".aar-head"));
  log(`heads: ${JSON.stringify(heads)}`);
  check(/VICTORY/.test(heads[0]) && /DEFEAT/.test(heads[1]), "the report's headline isn't VICTORY / DEFEAT");
  for (const h of heads) check(/vs your friend · River Lands · .* · practice link/.test(h), `the report's line: "${h}"`);
  for (const p of [phones.host, phones.guest]) {
    // (the order delay as felt: from the tap's drain to the step, mean and worst)
    const link = await text(p, ".duel-link");
    log(`${p.name}'s link: ${JSON.stringify(link)}`);
    check(/Order delay\s+[\d.]+ m?s on average\nSlowest order\s+[\d.]+ m?s/.test(link), `the ${p.name}'s report has no order delay: ${JSON.stringify(link)}`);
    check(/Practice link/.test(await text(p, ".duel-rec")), "the report doesn't say practice link");
    check((await p.page.locator("#duel-save").count()) === 1 && (await p.page.locator("#menu").count()) === 1, "Save battle or Main menu missing");
    check((await p.page.evaluate(() => localStorage.getItem("panache.duelenligne"))) === null, "a practice link wrote the win/loss record");
    // (the duel played the host's map and mutators, and saved neither over this phone's menu picks)
    const kept = await p.page.evaluate(() => JSON.parse(localStorage.getItem("panache.settings") ?? "null"));
    check(kept?.mapId === SETTINGS[p.name].mapId && JSON.stringify(kept?.mutators) === JSON.stringify(SETTINGS[p.name].mutators), `the duel saved over the ${p.name}'s settings: ${JSON.stringify(kept)}`);
  }
  await both((p) => shot(p, "4-report"));
}
// Save battle: the same battle on both phones
{
  const recs = await both(async (p) => {
    const [dl] = await Promise.all([p.page.waitForEvent("download", { timeout: 10000 }), p.page.locator("#duel-save").tap()]);
    return JSON.parse(readFileSync(await dl.path(), "utf8"));
  });
  const keep = (r) => JSON.stringify({ map: r.map, mutators: r.mutators, seed: r.seed, openers: r.openers, seats: r.seats, turns: r.turns, hashes: r.hashes, tick: r.tick, end: r.end, maxTicks: r.maxTicks });
  log(`records: ${recs[0].turns?.length} turns, ${recs[0].hashes?.length} hashes, end ${JSON.stringify(recs[0].end)}`);
  check(keep(recs[0]) === keep(recs[1]), "the two phones saved different battles");
  check(recs[0].v === 1 && recs[0].frames === "own", `the saved battle: v ${recs[0].v}, frames ${recs[0].frames}`);
  // (a match cut short by a failed progress check has fewer: that failure is the one to read)
  if (!cutShort) check(recs[0].hashes?.length >= 3 && recs[0].turns?.length >= 4, "the saved battle is thin");
  check(recs[0].seats?.blue?.player === "practice-duel:host" && recs[0].seats?.red?.player === "practice-duel:guest", `the seats: ${JSON.stringify(recs[0].seats)}`);
  // both sides' orders as stepped: the Fab taps, and the moves with the units they named
  const cmds = recs[0].turns.flatMap(([, , list]) => list);
  for (const f of ["blue", "red"]) {
    check(cmds.some((c) => c.faction === f && c.type === "startBuilding" && c.building === "fab-plant"), `${f}'s Fab tap isn't in the saved battle`);
    const ids = moved[f === "blue" ? "host" : "guest"];
    const sent = cmds.filter((c) => c.faction === f && c.type === "move").flatMap((c) => c.unitIds);
    check(ids.every((id) => sent.includes(id)), `${f}'s move isn't in the saved battle (${JSON.stringify(ids)})`);
    check(cmds.some((c) => c.faction === f && c.type === "resign") === (f === "red"), `the saved resigns: ${JSON.stringify(cmds.filter((c) => c.type === "resign"))}`);
  }
}

// --------------------------------------------------------- 3. rematch ---

log("3. rematch");
await phones.host.page.locator("#again").tap();
await phones.host.page.waitForSelector("#duel-rematch:not([disabled])", { timeout: 20000 });
await shot(phones.host, "5-rematch-boot");
await phones.host.page.locator("#duel-rematch").tap();
// (the guest is still on its report: the host's lobby frames say it's back)
const back = await run(20000, async () => /Your friend is back in the lobby/.test(await text(phones.guest, ".duel-back")));
check(back, "the guest's report didn't say \"Your friend is back in the lobby\"");
await shot(phones.guest, "5-friend-back");
await phones.guest.page.locator("#again").tap();
await phones.guest.page.waitForSelector("#duel-rematch:not([disabled])", { timeout: 20000 });
await phones.guest.page.locator("#duel-rematch").tap();
{
  const [h, g] = await both(paired);
  log(`rematch paired: host "${h.line}", guest "${g.line}"`);
  check(/you play red/i.test(h.line) && /you play blue/i.test(g.line), `the rematch didn't swap sides: host "${h.line}", guest "${g.line}"`);
  check(/River Lands/.test(h.map) && h.map === g.map && new RegExp(MUT_NAME).test(h.muts) && h.muts === g.muts, "the rematch isn't on the same map and mutators");
  await both((p) => shot(p, "5-rematch-paired"));
}
await both(cancel);

log(`air: ${air.stats()}`);
const errors = [...phones.host.errors, ...phones.guest.errors];
if (errors.length) fail(`console errors: ${JSON.stringify(errors.slice(0, 10))}`);
console.log(failed ? "DUEL SMOKE FAILED" : `DUEL SMOKE OK (seed ${SEED}, loss ${LOSS}, latency ${LATENCY}+${JITTER} ms, outage ${OUTAGE} ms)`);
air.close();
await browser.close();
server?.close();
