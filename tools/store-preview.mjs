// La vidéo d'aperçu de la fiche App Store (app preview) : iPhone 6,9" en paysage, 1920 × 886, 30 i/s, ~27 s, avec le son
// du jeu, dans ios/store/previews/<langue>.mp4.
//   npm run build && node tools/store-preview.mjs [fr|en]   (macOS : Google Chrome, ffmpeg)
// Deux plans tournés pour de vrai, comme tools/og-video.mjs (images du screencast, son pris sur la sortie Web Audio) :
// l'accueil tel qu'un joueur le voit, puis une escarmouche IA contre IA regardée en spectateur, la caméra passant d'un
// combat à l'autre. Apple n'accepte que des images du jeu : rien n'est ajouté par-dessus.
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const langs = process.argv[2] ? [process.argv[2]] : ["fr", "en"];
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../dist");
const OUT = join(HERE, "../ios/store/previews");
mkdirSync(OUT, { recursive: true });
const W = 1920;
const H = 886;
const VIEW = { viewport: { width: 960, height: 443 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true };
const HUB_MS = 4200;
// the camera: a first cut onto the busiest fight, then a new one every few seconds (the spectator's own camera
// follows the action in between)
const CUTS = [
  { at: 0, zoom: 40 },
  { at: 5500, zoom: 44 },
  { at: 11000, zoom: 38 },
  { at: 16500, zoom: 42 }
];
const INTO_S = 330; // at most this far into the match
const BATTLE_MS = 22500;

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".webp": "image/webp", ".json": "application/json", ".mp3": "audio/mpeg", ".mp4": "video/mp4", ".woff2": "font/woff2" };
const server = createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p.endsWith("/")) p += "index.html";
  const file = join(ROOT, p);
  if (!existsSync(file)) return void (res.writeHead(404), res.end());
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(8896, r));

/** In the page, before it runs: tee the Web Audio output into a stream; window.__rec() (re)starts a recorder on it. */
function tapAudio() {
  const connect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (dest, ...rest) {
    const r = connect.call(this, dest, ...rest);
    if (dest instanceof AudioDestinationNode) {
      const ctx = dest.context;
      if (!ctx.__tap) {
        ctx.__tap = ctx.createMediaStreamDestination();
        window.__stream = ctx.__tap.stream;
      }
      connect.call(this, ctx.__tap);
    }
    return r;
  };
  window.__rec = () => {
    if (!window.__stream) return false;
    const rec = new MediaRecorder(window.__stream, { mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: 192000 });
    const chunks = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    window.__audio = { rec, chunks, start: Date.now() / 1000 };
    rec.start(250);
    return true;
  };
  window.__stop = async () => {
    const a = window.__audio;
    if (!a) return null;
    await new Promise((done) => {
      a.rec.onstop = done;
      a.rec.stop();
    });
    const buf = new Uint8Array(await new Blob(a.chunks).arrayBuffer());
    let s = "";
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return { start: a.start, b64: btoa(s) };
  };
}

/** Films the page for ms, from `go` (an action run as the recording starts): a clip with its sound. */
async function film(ctx, page, dir, ms, go, during = async () => {}) {
  mkdirSync(dir, { recursive: true });
  const cdp = await ctx.newCDPSession(page);
  const frames = [];
  cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
    frames.push({ t: metadata.timestamp, data });
    cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => undefined);
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 95, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
  await page.waitForTimeout(300);
  const t0 = Date.now() / 1000;
  await go();
  await page.evaluate(() => window.__rec());
  await during();
  const left = t0 + ms / 1000 - Date.now() / 1000;
  if (left > 0) await page.waitForTimeout(left * 1000);
  await cdp.send("Page.stopScreencast");
  const audio = await page.evaluate(() => window.__stop());
  const kept = frames.filter((f, i) => f.t >= t0 || frames[i + 1]?.t > t0);
  let list = "";
  kept.forEach((f, i) => {
    const name = `${dir}/f${String(i).padStart(5, "0")}.jpg`;
    writeFileSync(name, Buffer.from(f.data, "base64"));
    const from = Math.max(f.t, t0);
    const to = kept[i + 1]?.t ?? t0 + ms / 1000;
    list += `file '${name}'\nduration ${(to - from).toFixed(4)}\n`;
  });
  list += `file '${dir}/f${String(kept.length - 1).padStart(5, "0")}.jpg'\n`;
  writeFileSync(`${dir}/frames.txt`, list);
  const clip = `${dir}/clip.mp4`;
  const args = ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", `${dir}/frames.txt`];
  if (audio) {
    writeFileSync(`${dir}/audio.webm`, Buffer.from(audio.b64, "base64"));
    args.push("-itsoffset", (audio.start - t0).toFixed(3), "-i", `${dir}/audio.webm`);
  } else args.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo");
  args.push(
    "-map", "0:v", "-map", "1:a",
    "-vf", `fps=30,scale=${W}:${H}:flags=lanczos,setsar=1,format=yuv420p`,
    "-af", "aresample=48000,apad", "-t", (ms / 1000).toFixed(2),
    "-c:v", "libx264", "-crf", "12", "-preset", "medium", "-c:a", "aac", "-b:a", "256k", "-ar", "48000", "-ac", "2", clip
  );
  execFileSync("ffmpeg", args);
  console.log(`  ${dir}: ${kept.length} images, son ${audio ? "pris" : "absent"}`);
  return clip;
}

const exe = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const browser = await chromium.launch({
  executablePath: exe,
  args: ["--use-gl=angle", "--use-angle=metal", "--ignore-gpu-blocklist", "--disable-blink-features=AutomationControlled", "--autoplay-policy=no-user-gesture-required"]
});

for (const lang of langs) {
  const base = `http://localhost:8896/${lang === "en" ? "en/" : ""}`;
  const tmp = `/tmp/store-preview/${lang}`;
  rmSync(tmp, { recursive: true, force: true });
  console.log(lang);

  // 1. the hub, as a player opens it
  const a = await browser.newContext(VIEW);
  await a.addInitScript((l) => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    localStorage.setItem("panache.lang", l);
    localStorage.setItem("panache.intro.seen", "1");
    localStorage.setItem("battledrones.tutorial", "done");
  }, lang);
  await a.addInitScript(tapAudio);
  const hub = await a.newPage();
  await hub.goto(base, { waitUntil: "networkidle" });
  await hub.waitForTimeout(1500);
  const clipHub = await film(a, hub, `${tmp}/hub`, HUB_MS, () => hub.mouse.click(480, 220));
  await a.close();

  // 2. a battle, watched: well into the match, the camera from one fight to the next. The AI's matches differ each
  // time: one that ends (or has too little going on) while filmed is filmed again.
  let clipWar = null;
  for (let tries = 1; !clipWar && tries <= 6; tries++) {
    const b = await browser.newContext(VIEW);
    await b.addInitScript((l) => {
      localStorage.setItem("panache.lang", l);
      localStorage.setItem("panache.intro.seen", "1");
      const k = "battledrones.settings";
      const cur = JSON.parse(localStorage.getItem(k) || "{}");
      localStorage.setItem(k, JSON.stringify({ ...cur, mapId: "dune-sea", mode: "skirmish" }));
    }, lang);
    await b.addInitScript(tapAudio);
    const war = await b.newPage();
    await war.goto(base, { waitUntil: "networkidle" });
    await war.waitForTimeout(800);
    await war.evaluate(() => document.querySelector("#play-spectate").click());
    await war.waitForFunction(() => window.__bd?.world?.tick > 0, null, { timeout: 60_000 });
    // forward, 10 s at a time, to a big battle: both armies in strength
    const ready = await war.evaluate((max) => {
      const { world: w, scene } = window.__bd;
      for (let s = 0; s < max; s += 10) {
        scene.step(100, 100, false);
        if (w.winner) return false;
        const n = { blue: 0, red: 0 };
        for (const u of w.units.values()) n[u.faction] = (n[u.faction] ?? 0) + 1;
        if (s >= 150 && n.blue >= 18 && n.red >= 18) return true;
      }
      return false;
    }, INTO_S);
    if (!ready) {
      console.log(`  partie ${tries} : pas de grande bataille, une autre`);
      await b.close();
      continue;
    }
    const cut = (zoom, skip) =>
      war.evaluate(
        ([zoom, skip]) => {
          // the fights: units with foes close by, the busiest first, each away from the ones before
          const w = window.__bd.world;
          const us = [...w.units.values()];
          const spots = [];
          for (const u of us) {
            let n = 0;
            let foe = false;
            for (const v of us) {
              const d = (u.x - v.x) ** 2 + (u.y - v.y) ** 2;
              if (d < 64) {
                n++;
                if (v.faction !== u.faction) foe = true;
              }
            }
            if (foe) spots.push({ x: u.x, y: u.y, n });
          }
          spots.sort((p, q) => q.n - p.n);
          const seen = window.__seen ?? (window.__seen = []);
          const far = spots.filter((s) => seen.every((p) => (p.x - s.x) ** 2 + (p.y - s.y) ** 2 > 400));
          const pick = (skip ? far[0] : spots[0]) ?? spots[0];
          if (!pick) return false;
          seen.push(pick);
          window.__bd.scene.cutTo(pick.x, pick.y, "blue", zoom);
          return true;
        },
        [zoom, skip]
      );
    await cut(CUTS[0].zoom, false);
    await war.waitForTimeout(1500);
    const clip = await film(b, war, `${tmp}/war${tries}`, BATTLE_MS, async () => {}, async () => {
      const t0 = Date.now();
      for (const c of CUTS.slice(1)) {
        await war.waitForTimeout(Math.max(0, c.at - (Date.now() - t0)));
        await cut(c.zoom, true);
      }
    });
    const over = await war.evaluate(() => Boolean(window.__bd.world.winner));
    await b.close();
    if (over) console.log(`  partie ${tries} : finie pendant le plan, une autre`);
    else clipWar = clip;
  }
  if (!clipWar) throw new Error("pas de bataille filmée jusqu'au bout");

  // the two, crossfaded, faded out at the end
  const total = (HUB_MS + BATTLE_MS) / 1000 - 0.5;
  const out = join(OUT, `${lang}.mp4`);
  execFileSync("ffmpeg", [
    "-y", "-loglevel", "error", "-i", clipHub, "-i", clipWar,
    "-filter_complex",
    `[0:v][1:v]xfade=transition=fade:duration=0.5:offset=${(HUB_MS / 1000 - 0.5).toFixed(2)},fade=t=out:st=${(total - 1).toFixed(2)}:d=1[v];` +
      `[0:a][1:a]acrossfade=d=0.5,afade=t=out:st=${(total - 1.2).toFixed(2)}:d=1.2[a]`,
    "-map", "[v]", "-map", "[a]", "-t", total.toFixed(2),
    "-r", "30", "-c:v", "libx264", "-profile:v", "high", "-level", "4.0", "-pix_fmt", "yuv420p", "-b:v", "10M", "-maxrate", "12M", "-bufsize", "20M",
    "-c:a", "aac", "-b:a", "256k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart", out
  ]);
  console.log(`ios/store/previews/${lang}.mp4 (${total.toFixed(1)} s)`);
}
await browser.close();
server.close();
