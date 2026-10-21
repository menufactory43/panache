// HUD portraits shot from the in-game 3D models (ICONS.md): public/assets/icons/<kind>.webp, and
// red/<kind>.webp for every unit and building (the objectives are neutral). Each is the model
// gallery's ?icon=<kind> view (tools/models.ts) framed as FRAMING says, shot on black and on white
// (the pair gives a clean alpha), fitted to 224 px in a 256 px square, then finished for the HUD's
// dark navy buttons: the shadows lifted and a thin light rim drawn round the silhouette.
// Usage: npx vite --port 5173, then
//   node tools/model-portraits.mjs --all          every portrait, blue and red (about 8 minutes)
//   node tools/model-portraits.mjs lancer hq      just these, blue
//     [--faction=red] [--out=public/assets/icons] (a scratch folder, to try a look without touching
//     the shipped portraits) [--pitch=50] (degrees below the horizon) [--turn=0.6] (rad, clockwise
//     from nose north) [--head=0] (rad, a building's turret or head turned on its mount)
//     [--solo] (one robot of a squad) [--url=http://localhost:5173/tools/models.html]
import { chromium } from "playwright-core";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

// (src/game/assets.ts UNIT_KINDS and BUILDING_KINDS, then the two map objectives)
const UNITS = [
  "harvester", "scout", "stinger", "flak-crawler", "mortar", "mastodon", "lancer",
  "wasp", "raptor", "hornet", "mender", "trooper", "rocket-squad", "sniper", "condor", "goliath"
];
const BUILDINGS = ["hq", "fab-plant", "airpad", "tech-lab", "depot", "turret", "sam-site", "radar", "assembly-bay", "gantry"];
const OBJECTIVES = ["uplink", "supply-crate"];

/** A ¾ showroom view: close to the game camera (47–62°), nose up and to the right, so long hulls lie along the diagonal. */
const SHOWROOM = { pitch: 50, turn: 0.6, solo: false };
/** Robots are characters: one of the squad, weapon up, from lower down and turned to face the viewer. */
const ROBOT = { pitch: 30, turn: 2.5, solo: true };
const FRAMING = {
  trooper: ROBOT, "rocket-squad": ROBOT, sniper: ROBOT, goliath: { pitch: 30, turn: 0.6, solo: false },
  // (their dishes face north at rest, so from the showroom angle we'd see their backs: turn them to the viewer)
  radar: { ...SHOWROOM, head: 2.6 },
  uplink: { ...SHOWROOM, head: 2.6 }
};

const SIZE = 256;
const FIT = 224;
/** The finish: a gamma and gain on colour (dark gunmetal sinks into the navy buttons otherwise)... */
const GAMMA = 0.82;
const GAIN = 1.06;
/** ...and a rim: the silhouette grown by RIM_R px, softened, in a neutral light that suits both sides. */
const RIM_R = 4;
const RIM = [226, 232, 240];
const RIM_A = 0.5;

const args = process.argv.slice(2);
const opt = Object.fromEntries(args.filter((a) => a.startsWith("--")).map((a) => a.slice(2).split("=")));
const url = opt.url ?? "http://localhost:5173/tools/models.html";
const out = opt.out ?? "public/assets/icons";
const jobs = [];
if ("all" in opt) {
  for (const k of [...UNITS, ...BUILDINGS, ...OBJECTIVES]) jobs.push({ kind: k, faction: "blue" });
  for (const k of [...UNITS, ...BUILDINGS]) jobs.push({ kind: k, faction: "red" });
} else for (const k of args.filter((a) => !a.startsWith("--"))) jobs.push({ kind: k, faction: opt.faction ?? "blue" });

const exe = ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((p) => existsSync(p));
const browser = await chromium.launch({
  executablePath: exe,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
});
const page = await browser.newPage({ viewport: { width: 512, height: 512 }, deviceScaleFactor: 1 });

for (const { kind, faction } of jobs) {
  const f = { ...SHOWROOM, ...FRAMING[kind] };
  const pitch = opt.pitch ?? f.pitch;
  const turn = opt.turn ?? f.turn;
  const solo = "solo" in opt || f.solo;
  const head = opt.head ?? f.head ?? 0;
  const shots = [];
  for (const bg of ["#000000", "#ffffff"]) {
    const q = `icon=${kind}&bg=${encodeURIComponent(bg)}&pitch=${pitch}&turn=${turn}&head=${head}&faction=${faction}${solo ? "&solo" : ""}`;
    await page.goto(`${url}?${q}`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => window.ready, null, { timeout: 30000 });
    await page.waitForTimeout(500);
    shots.push(`data:image/png;base64,${(await page.screenshot()).toString("base64")}`);
  }
  const { webp, clipped } = await page.evaluate(async ([black, white, P]) => {
    const load = async (src) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const x = c.getContext("2d");
      x.drawImage(img, 0, 0);
      return x.getImageData(0, 0, c.width, c.height);
    };
    const B = await load(black);
    const W = await load(white);
    const { width: w, height: h } = B;
    const shot = new ImageData(w, h);
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let i = 0; i < w * h; i++) {
      // over black a pixel is a·c, over white a·c + (1 − a): the difference is 1 − a
      let d = 0;
      for (let k = 0; k < 3; k++) d += W.data[i * 4 + k] - B.data[i * 4 + k];
      const a = Math.min(1, Math.max(0, 1 - d / 765));
      if (a < 1 / 255) continue;
      for (let k = 0; k < 3; k++) shot.data[i * 4 + k] = Math.min(255, B.data[i * 4 + k] / a);
      shot.data[i * 4 + 3] = Math.round(a * 255);
      if (a > 8 / 255) {
        const px = i % w, py = (i / w) | 0;
        x0 = Math.min(x0, px); x1 = Math.max(x1, px);
        y0 = Math.min(y0, py); y1 = Math.max(y1, py);
      }
    }
    const src = document.createElement("canvas");
    src.width = w;
    src.height = h;
    src.getContext("2d").putImageData(shot, 0, 0);
    const S = P.SIZE;
    const s = P.FIT / Math.max(x1 - x0 + 1, y1 - y0 + 1);
    const dst = document.createElement("canvas");
    dst.width = dst.height = S;
    const g = dst.getContext("2d");
    g.imageSmoothingQuality = "high";
    const dw = (x1 - x0 + 1) * s;
    const dh = (y1 - y0 + 1) * s;
    g.drawImage(src, x0, y0, x1 - x0 + 1, y1 - y0 + 1, (S - dw) / 2, (S - dh) / 2, dw, dh);

    // the finish, on straight (unpremultiplied) colour
    const img = g.getImageData(0, 0, S, S);
    const px = img.data;
    const A = new Float32Array(S * S);
    for (let i = 0; i < S * S; i++) A[i] = px[i * 4 + 3] / 255;
    // grow the silhouette: a separable max over ±RIM_R px...
    const grow = (src, dx, dy) => {
      const o = new Float32Array(S * S);
      for (let y = 0; y < S; y++)
        for (let x = 0; x < S; x++) {
          let m = 0;
          for (let r = -P.RIM_R; r <= P.RIM_R; r++) {
            const xx = x + r * dx, yy = y + r * dy;
            if (xx >= 0 && yy >= 0 && xx < S && yy < S) m = Math.max(m, src[yy * S + xx]);
          }
          o[y * S + x] = m;
        }
      return o;
    };
    // ...then soften it with two 3 × 3 box blurs (about a 1.2 px Gaussian)
    const blur = (src) => {
      const o = new Float32Array(S * S);
      for (let y = 0; y < S; y++)
        for (let x = 0; x < S; x++) {
          let sum = 0, n = 0;
          for (let j = -1; j <= 1; j++)
            for (let i = -1; i <= 1; i++) {
              const xx = x + i, yy = y + j;
              if (xx >= 0 && yy >= 0 && xx < S && yy < S) (sum += src[yy * S + xx]), n++;
            }
          o[y * S + x] = sum / n;
        }
      return o;
    };
    const G = blur(blur(grow(grow(A, 1, 0), 0, 1)));
    for (let i = 0; i < S * S; i++) {
      const a = A[i];
      const rim = Math.max(0, G[i] - a) * P.RIM_A;
      const oa = a + rim * (1 - a);
      if (oa <= 0) continue;
      for (let k = 0; k < 3; k++) {
        const c = Math.min(255, 255 * Math.pow(px[i * 4 + k] / 255, P.GAMMA) * P.GAIN);
        px[i * 4 + k] = Math.round((c * a + P.RIM[k] * rim * (1 - a)) / oa);
      }
      px[i * 4 + 3] = Math.round(oa * 255);
    }
    g.putImageData(img, 0, 0);
    // (a model touching the edge of the shot was cut off by the gallery's framing)
    return { webp: dst.toDataURL("image/webp", 0.85), clipped: x0 === 0 || y0 === 0 || x1 === w - 1 || y1 === h - 1 };
  }, [...shots, { SIZE, FIT, GAMMA, GAIN, RIM_R, RIM, RIM_A }]);
  const dir = faction === "red" ? `${out}/red` : out;
  mkdirSync(dir, { recursive: true });
  const file = `${dir}/${kind}.webp`;
  writeFileSync(file, Buffer.from(webp.split(",")[1], "base64"));
  console.log(clipped ? `${file} — WARNING: the model touches the edge of the shot, so part of it is cut off` : file);
}
await browser.close();
