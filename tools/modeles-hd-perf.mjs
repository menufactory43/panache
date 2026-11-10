// Mesure de rendu des modèles cuits contre les modèles procéduraux (`?hd=0`), avec `npm run dev` lancé :
//   node tools/modeles-hd-perf.mjs [port]
// Une partie normale, en pause ; on pose près du QG trois exemplaires de chaque unité par camp et un bâtiment
// de chaque sorte, puis on dessine 300 images d'affilée (sans attendre l'écran) et on lit le temps par image,
// les appels de dessin, les triangles, les textures et la mémoire. Deux écrans : bureau et téléphone.
import { chromium } from "playwright-core";

const port = process.argv[2] ?? "5173";
const SCREENS = [["bureau 1280×800 @2", 1280, 800, 2], ["téléphone 844×390 @3", 844, 390, 3]];
const browser = await chromium.launch({ channel: "chrome", args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist", "--enable-precise-memory-info", "--disable-gpu-vsync", "--disable-frame-rate-limit"] });
const rows = [];
for (const [label, w, h, dpr] of SCREENS)
  for (const mode of ["hd=0", "hd=1"]) {
    const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: dpr });
    page.on("pageerror", (e) => console.log("ERREUR", e.message));
    let bytes = 0, files = 0;
    page.on("response", async (r) => {
      if (!r.url().includes("/assets/models/")) return;
      files++;
      bytes += (await r.body().catch(() => Buffer.alloc(0))).length;
    });
    await page.goto(`http://localhost:${port}/?${mode}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(600);
    await page.evaluate(() => document.querySelector("#play").click());
    await page.waitForSelector(".op-card", { timeout: 30000 });
    await page.waitForTimeout(500);
    const t0 = Date.now();
    await page.click(".op-card");
    await page.waitForFunction(() => window.__bd?.world?.tick > 5, null, { timeout: 120000 });
    const loadMs = Date.now() - t0;
    const res = await page.evaluate(async () => {
      const { spawnBuilding } = await import("/src/sim/world.ts");
      const { UNITS, BUILDINGS } = await import("/src/sim/balance.ts");
      const { world, spawn, cam, scene, ctrl, three } = window.__bd;
      const dx = Math.sign(world.width / 2 - cam.x) || 1, dy = Math.sign(world.height / 2 - cam.y) || 1;
      const cx = cam.x + dx * 6, cy = cam.y + dy * 5;
      const kinds = Object.keys(UNITS).filter((k) => !["goliath", "zenith"].includes(k));
      let n = 0;
      for (const f of ["blue", "red"])
        for (let rep = 0; rep < 3; rep++)
          kinds.forEach((k, i) => {
            const col = i % 9, row = Math.floor(i / 9) + rep * 3 + (f === "red" ? 9 : 0);
            try { world.units.get(spawn(k, f, cx + (col - 4) * 1.5, cy + (row - 9) * 1.3)).facing = (n++ * 0.7) % 6.28; } catch {}
          });
      let nb = 0;
      Object.keys(BUILDINGS).forEach((k, i) => {
        try { spawnBuilding(world, k, "blue", Math.round(cx + ((i % 6) - 2.5) * 3.2), Math.round(cy + (Math.floor(i / 6) + 5.5) * 3.2)); nb++; } catch {}
      });
      ctrl.paused = true;
      // (un pas de simulation pour que tout existe à l'écran, puis la pause)
      ctrl.paused = false; scene.update(120); ctrl.paused = true;
      cam.zoom = 30;
      cam.centerOn(cx, cy + 1);
      const r = three.stage.renderer;
      const gl = r.getContext();
      const px = new Uint8Array(4);
      const settle = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      for (let i = 0; i < 40; i++) scene.update(16);
      settle();
      r.info.autoReset = true;
      const N = 300;
      const a = performance.now();
      for (let i = 0; i < N; i++) scene.update(16);
      settle();
      const ms = (performance.now() - a) / N;
      // (la part du processeur seul : sans attendre la carte graphique)
      const b = performance.now();
      for (let i = 0; i < 100; i++) scene.update(16);
      const cpu = (performance.now() - b) / 100;
      settle();
      let texBytes = 0;
      const seen = new Set();
      three.stage.scene.traverse((o) => {
        const m = o.material;
        for (const t of [m?.map, m?.normalMap, m?.aoMap]) {
          if (!t?.image?.width || seen.has(t.uuid)) continue;
          seen.add(t.uuid);
          if (o.userData.skin) texBytes += t.image.width * t.image.height * 4 * 1.333;
        }
      });
      return {
        units: world.units.size, buildings: world.buildings.size, ms, cpu, calls: r.info.render.calls, tris: r.info.render.triangles,
        textures: r.info.memory.textures, geometries: r.info.memory.geometries, programs: r.info.programs.length,
        heap: performance.memory?.usedJSHeapSize ?? 0, skinTex: texBytes, ratio: three.stage.pixelRatio
      };
    });
    await page.screenshot({ path: `progress-shots/modeles-hd/perf-${w}-${mode.replace("=", "")}.png` });
    rows.push({ écran: label, mode: mode === "hd=0" ? "avant" : "cuits", "ms/image": +res.ms.toFixed(2), "dont CPU": +res.cpu.toFixed(2), appels: res.calls, triangles: res.tris,
      textures: res.textures, programmes: res.programs, "tas JS (Mo)": Math.round(res.heap / 1048576), "textures cuites à l'écran (Mo GPU)": Math.round(res.skinTex / 1048576),
      "chargement (ms)": loadMs, "fichiers modèles": files, "Mo téléchargés": +(bytes / 1048576).toFixed(1), unités: res.units, bâtiments: res.buildings, "pixel ratio": res.ratio });
    await page.close();
    console.log(JSON.stringify(rows[rows.length - 1]));
  }
await browser.close();
