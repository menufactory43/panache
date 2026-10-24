// The share videos (og:video): public/og.mp4 in French and public/og-en.mp4 in
// English, 1280×720. Each is the game's own intro film (src/ui/title.ts) as a
// first-time player sees it, in that language, with its sound: the leader, the
// silent film's intertitles, the logo slamming in on the fanfare, the menu.
//
// Chrome plays the page for real (not as a robot: the intro is skipped for
// navigator.webdriver), its frames come from the DevTools screencast and its
// sound from a tap on the Web Audio output (every node that reaches the
// speakers also feeds a MediaRecorder); ffmpeg puts the two together, the
// film grain smoothed a little so each stays near 4 MB.
// Usage: node tools/og-video.mjs [url]   (a dev server: npx vite; macOS: Google Chrome, ffmpeg)
import { chromium } from "playwright-core";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const [, , url = "http://localhost:5173/"] = process.argv;
const root = fileURLToPath(new URL("..", import.meta.url));
const W = 1280;
const H = 720;
const FILM_MS = 24500; // the tap to a few seconds of menu after the slam (title.ts T.slam = 19.8 s)
const SLAM_S = 19.8; // title.ts T.slam
const OUT = { fr: "og.mp4", en: "og-en.mp4" };

/** A recording's loudness, [time s, RMS dB] every 50 ms. */
function levels(file) {
  const log = spawnSync("ffmpeg", [
    "-i", file, "-vn", "-af",
    "aresample=44100,asetnsamples=2205,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level",
    "-f", "null", "-"
  ]).stderr.toString(); // (ametadata prints to the log)
  return [...log.matchAll(/pts_time:([\d.]+)[\s\S]*?RMS_level=(-?[\d.inf]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
}

/** In the page, before it runs: tee the Web Audio output into a recorder. */
function tapAudio() {
  const connect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (dest, ...rest) {
    const r = connect.call(this, dest, ...rest);
    if (dest instanceof AudioDestinationNode) {
      const ctx = dest.context;
      if (!ctx.__tap) {
        ctx.__tap = ctx.createMediaStreamDestination();
        const rec = new MediaRecorder(ctx.__tap.stream, { mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: 160000 });
        const chunks = [];
        rec.ondataavailable = (e) => chunks.push(e.data);
        window.__audio = { rec, chunks, start: Date.now() / 1000 };
        rec.start(250);
      }
      connect.call(this, ctx.__tap);
    }
    return r;
  };
}

const browser = await chromium.launch({
  channel: "chrome",
  args: ["--disable-blink-features=AutomationControlled", "--autoplay-policy=no-user-gesture-required"]
});

for (const [lang, file] of Object.entries(OUT)) {
  const tmp = `/tmp/og-video/${lang}`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  await ctx.addInitScript((l) => {
    localStorage.setItem("panache.lang", l);
    localStorage.removeItem("panache.intro.seen");
  }, lang);
  await ctx.addInitScript(tapAudio);
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: "networkidle" });
  if (await page.evaluate(() => navigator.webdriver)) throw new Error("Chrome says it is a robot: no intro film");
  await page.waitForTimeout(1500); // the press-start settles, the film's pictures load

  const cdp = await ctx.newCDPSession(page);
  const frames = [];
  cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
    frames.push({ t: metadata.timestamp, data });
    cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => undefined);
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
  await page.waitForTimeout(400);
  const tap = Date.now() / 1000;
  await page.mouse.click(W / 2, H / 2);
  await page.waitForTimeout(FILM_MS);
  await cdp.send("Page.stopScreencast");
  const audio = await page.evaluate(async () => {
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
  });
  await ctx.close();
  if (!audio) throw new Error("no sound came out of the page");

  // the frames from just before the tap, each held until the next (the screencast sends only changes)
  const start = tap - 0.3;
  const kept = frames.filter((f, i) => f.t >= start || frames[i + 1]?.t > start);
  let list = "";
  kept.forEach((f, i) => {
    const name = `${tmp}/f${String(i).padStart(5, "0")}.jpg`;
    writeFileSync(name, Buffer.from(f.data, "base64"));
    const from = Math.max(f.t, start);
    const to = kept[i + 1]?.t ?? tap + FILM_MS / 1000;
    list += `file '${name}'\nduration ${(to - from).toFixed(4)}\n`;
  });
  list += `file '${tmp}/f${String(kept.length - 1).padStart(5, "0")}.jpg'\n`;
  writeFileSync(`${tmp}/frames.txt`, list);
  writeFileSync(`${tmp}/audio.webm`, Buffer.from(audio.b64, "base64"));

  // the sound to the film's clock: the recorder's start time is only roughly when the sound
  // begins, so the fanfare (it sounds as the logo slams, SLAM_S after the tap) sets it exactly
  const guess = tap + SLAM_S - audio.start; // the fanfare's time in the recording, roughly
  const fanfare = levels(`${tmp}/audio.webm`).find(([t, db]) => Math.abs(t - guess) < 1.5 && db > -20)?.[0];
  if (fanfare === undefined) throw new Error("no fanfare heard near the slam");
  const offset = tap + SLAM_S - start - fanfare;
  const dur = (tap + FILM_MS / 1000 - start).toFixed(2);
  const fade = (Number(dur) - 1.2).toFixed(2);
  execFileSync("ffmpeg", [
    "-y", "-loglevel", "error",
    "-f", "concat", "-safe", "0", "-i", `${tmp}/frames.txt`,
    "-itsoffset", offset.toFixed(3), "-i", `${tmp}/audio.webm`,
    "-map", "0:v", "-map", "1:a",
    "-vf", `fps=30,scale=${W}:${H},hqdn3d=4:3:6:4,format=yuv420p,fade=t=out:st=${fade}:d=1.2`,
    "-af", `apad,afade=t=out:st=${fade}:d=1.2`,
    "-t", dur,
    "-c:v", "libx264", "-preset", "slow", "-crf", "32", "-profile:v", "high", "-movflags", "+faststart",
    "-c:a", "aac", "-b:a", "128k",
    `${root}public/${file}`
  ]);
  console.log(`public/${file}: ${kept.length} frames, sound offset ${offset.toFixed(2)} s`);
}
await browser.close();
