import { BUILDINGS, OBJECTIVES } from "../sim/balance";
import type { MapDef } from "../sim/maps";
import type { UplinkDef } from "../sim/objectives";
import { Terrain, type Biome } from "../sim/types";
import { paintMapPixels } from "../game/terrain-paint";
import { tr } from "../lang";

/**
 * The full-map preview (the menu's 🔍 View full map, Preview mode): a big,
 * crisp painting of a generated map with both HQs, the Uplinks and the
 * supply-drop sites marked, its vital statistics, and Play / Reroll / Close.
 * Tapping the map toggles fit and 2× (scroll or drag to look around).
 */

/** Pixels per tile: 108 tiles → 1188 px, crisp at fit on a laptop and fine at 2× on a phone. */
const PREVIEW_PX = 11;

const BIOME_ICON: Record<Biome, string> = { temperate: "🌳", desert: "🏜️", arctic: "❄️", volcanic: "🌋", tropical: "🌴" };
const BIOME_FR: Record<Biome, string> = tr(
  { temperate: "tempéré", desert: "désert", arctic: "arctique", volcanic: "volcanique", tropical: "tropical" },
  { temperate: "temperate", desert: "desert", arctic: "arctic", volcanic: "volcanic", tropical: "tropical" }
);

/**
 * How thick the Shallows rim along the water runs (tiles), per biome: arctic
 * ice shelves and tropical reefs line every bank, so only a ford's core —
 * further from dry land than the rim reaches — tells a ford from the shore.
 * (A rough count: a wide frozen lake's shelf can pass for a ford.)
 */
const RIM: Partial<Record<Biome, number>> = { arctic: 3, tropical: 2 };

export interface MapStats {
  scrap: number;
  crystal: number;
  bridges: number;
  fords: number;
  /** Shares of the map, 0–1. */
  water: number;
  forest: number;
}

/** Count the 8-connected patches of tiles `hit` picks (patches under `min` tiles are paint noise). */
function patches(grid: Uint8Array, n: number, hit: (i: number) => boolean, min = 2): number {
  const seen = new Uint8Array(grid.length);
  const stack: number[] = [];
  let count = 0;
  for (let i = 0; i < grid.length; i++) {
    if (seen[i] || !hit(i)) continue;
    let size = 0;
    seen[i] = 1;
    stack.push(i);
    while (stack.length) {
      const k = stack.pop()!;
      size++;
      const x = k % n;
      const y = (k - x) / n;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
          const j = ny * n + nx;
          if (!seen[j] && hit(j)) {
            seen[j] = 1;
            stack.push(j);
          }
        }
    }
    if (size >= min) count++;
  }
  return count;
}

/** A generated map's vital statistics, read off its terrain grid (null for a hand-made map). */
export function mapStats(def: MapDef): MapStats | null {
  const g = def.random?.terrain;
  if (!g) return null;
  const n = def.size;
  const wet = (t: number) => t === Terrain.Water || t === Terrain.Deep;
  let water = 0;
  let forest = 0;
  for (const t of g) {
    if (wet(t)) water++;
    else if (t === Terrain.Forest) forest++;
  }
  // a ford's core: Shallows further than the biome's rim from any dry tile (Chebyshev distance)
  const rim = RIM[def.biome] ?? 0;
  let fordAt = (i: number) => g[i] === Terrain.Shallows;
  if (rim) {
    const dist = new Int16Array(g.length).fill(-1);
    let front: number[] = [];
    for (let i = 0; i < g.length; i++)
      if (!wet(g[i]!) && g[i] !== Terrain.Shallows) {
        dist[i] = 0;
        front.push(i);
      }
    for (let d = 1; front.length && d <= rim; d++) {
      const next: number[] = [];
      for (const k of front) {
        const x = k % n;
        const y = (k - x) / n;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
            const j = ny * n + nx;
            if (dist[j] === -1) {
              dist[j] = d;
              next.push(j);
            }
          }
      }
      front = next;
    }
    fordAt = (i) => g[i] === Terrain.Shallows && dist[i] === -1;
  }
  return {
    scrap: patches(g, n, (i) => g[i] === Terrain.Scrap, 3),
    crystal: patches(g, n, (i) => g[i] === Terrain.Crystal, 2),
    bridges: patches(g, n, (i) => g[i] === Terrain.Bridge, 2),
    fords: patches(g, n, fordAt, 2),
    water: water / g.length,
    forest: forest / g.length
  };
}

/** Painted previews, kept for a few maps so reopening (or rerolling back via a chip) is instant. */
const painted = new Map<string, HTMLCanvasElement>();

function paintCanvas(def: MapDef): HTMLCanvasElement | null {
  const hit = painted.get(def.id);
  if (hit) return hit;
  const data = paintMapPixels(def, PREVIEW_PX);
  if (!data) return null;
  const px = def.size * PREVIEW_PX;
  const cv = document.createElement("canvas");
  cv.width = cv.height = px;
  cv.getContext("2d")!.putImageData(new ImageData(data as Uint8ClampedArray<ArrayBuffer>, px, px), 0, 0);
  if (painted.size >= 4) painted.delete(painted.keys().next().value!);
  painted.set(def.id, cv);
  return cv;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
const f1 = (v: number) => +v.toFixed(2);

/** The markers, in tile units (the SVG's viewBox is the map): HQs, Uplinks with their capture rings, drop sites. */
function markersSvg(def: MapDef): string {
  const n = def.size;
  const hs = BUILDINGS.hq.size;
  const [hx, hy] = def.hq;
  const hq = (x: number, y: number, side: "b" | "r") =>
    `<g class="mk-hq ${side}"><rect x="${x - 0.9}" y="${y - 0.9}" width="${hs + 1.8}" height="${hs + 1.8}" rx="1.1" class="halo"/>` +
    `<rect x="${x}" y="${y}" width="${hs}" height="${hs}" rx="0.5"/>` +
    `<text x="${x + hs / 2}" y="${y + hs / 2}">${tr("GQG", "GHQ")}</text></g>`;
  const pts: [number, number][] = [];
  const add = (x: number, y: number) => {
    if (!pts.some(([a, b]) => Math.hypot(a - x, b - y) < 0.01)) pts.push([x, y]);
  };
  for (const u of def.uplinks as readonly UplinkDef[]) {
    const [x, y] = Array.isArray(u) ? u : u.at;
    add(x, y);
    add(n - x, n - y);
  }
  const r = OBJECTIVES.uplink.radius;
  const uplinks = pts
    .map(([x, y]) => `<g class="mk-up"><circle cx="${f1(x)}" cy="${f1(y)}" r="${r}" class="ring"/><circle cx="${f1(x)}" cy="${f1(y)}" r="0.75"/></g>`)
    .join("");
  const drops = def.dropSites
    .flatMap(([x, y]) => [[x, y], [n - x, n - y]])
    .map(([x, y]) => `<rect class="mk-drop" x="${f1(x! - 0.8)}" y="${f1(y! - 0.8)}" width="1.6" height="1.6" transform="rotate(45 ${f1(x!)} ${f1(y!)})"/>`)
    .join("");
  return `<svg class="mp-marks" viewBox="0 0 ${n} ${n}" aria-hidden="true">${uplinks}${drops}${hq(hx, hy, "b")}${hq(n - hx - hs, n - hy - hs, "r")}</svg>`;
}

function statChips(def: MapDef): string {
  const s = mapStats(def);
  if (!s) return "";
  const lava = def.biome === "volcanic";
  const chip = (icon: string, v: number | string, label: string, zero = v === 0) =>
    `<span class="mp-chip${zero ? " zero" : ""}">${icon} <b>${v}</b> ${label}</span>`;
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  return [
    chip("⛏", s.scrap, tr(s.scrap === 1 ? "gisement de charbon" : "gisements de charbon", s.scrap === 1 ? "coal seam" : "coal seams")),
    chip("💎", s.crystal, tr(s.crystal === 1 ? "gisement de radium" : "gisements de radium", s.crystal === 1 ? "radium seam" : "radium seams")),
    chip("🌉", s.bridges, tr(s.bridges === 1 ? "pont" : "ponts", s.bridges === 1 ? "bridge" : "bridges")),
    chip("〰️", s.fords, tr(s.fords === 1 ? "gué" : "gués", s.fords === 1 ? "ford" : "fords")),
    chip(lava ? "🔥" : "💧", pct(s.water), lava ? tr("lave", "lava") : tr("eau", "water"), s.water < 0.005),
    chip("🌲", pct(s.forest), tr("bois", "woods"), s.forest < 0.005)
  ].join("");
}

export interface MapPreviewHooks {
  /** Where the overlay lives (the menu: leaving it takes the overlay along). */
  host: HTMLElement;
  /** The primary button's label (default "▶ Play this map"). */
  playLabel?: string;
  /** Start the match on the previewed map (the overlay has closed). */
  onPlay(): void;
  /** Roll another map (the menu keeps its pick in step) and hand it over to show. */
  onReroll(): MapDef;
  onClose?(): void;
}

/** The open preview's close() (one at a time: reopening closes the last, Esc listener and all). */
let closeOpen: (() => void) | null = null;

/** Open the full-map preview of a generated map. Returns its close(). */
export function openMapPreview(def: MapDef, hooks: MapPreviewHooks): () => void {
  closeOpen?.();
  const wrap = document.createElement("div");
  wrap.className = "mapprev";
  wrap.setAttribute("role", "dialog");
  wrap.setAttribute("aria-modal", "true");
  wrap.innerHTML = `
    <div class="mp-box">
      <div class="mp-head">
        <div class="mp-title"><h2 class="mp-name"></h2><p class="mp-meta"></p></div>
        <button class="mp-x" data-a="close" title="${tr("Fermer (Échap)", "Close (Esc)")}" aria-label="${tr("Fermer", "Close")}">✕</button>
      </div>
      <div class="mp-view" title="${tr("Touche pour zoomer", "Tap to zoom")}">
        <div class="mp-stage"><div class="mp-wait"><i></i>${tr("Relevé en cours…", "Surveying…")}</div></div>
        <span class="mp-zoom">${tr("🔍 Touche pour zoomer", "🔍 Tap to zoom")}</span>
      </div>
      <div class="mp-side">
        <p class="mp-blurb"></p>
        <div class="mp-stats"></div>
        <div class="mp-legend">
          <span><i class="k-hq b"></i>${tr("Ton GQG", "Your GHQ")}</span>
          <span><i class="k-hq r"></i>${tr("GQG ennemi", "Enemy GHQ")}</span>
          <span><i class="k-up"></i>${tr("Relais TSF", "Wireless Relay")}</span>
          <span><i class="k-drop"></i>${tr("Ravitaillement", "Supply")}</span>
        </div>
        <div class="mp-actions">
          <button class="cta alt" data-a="close">${tr("✕ Fermer", "✕ Close")}</button>
          <button class="cta alt" data-a="reroll">${tr("🎲 Relancer", "🎲 Reroll")}</button>
          <button class="cta" data-a="play"></button>
        </div>
      </div>
    </div>`;
  hooks.host.appendChild(wrap);
  wrap.querySelector('[data-a="play"]')!.textContent = hooks.playLabel ?? tr("▶ Jouer cette carte", "▶ Play this map");
  const view = wrap.querySelector<HTMLElement>(".mp-view")!;
  const stage = wrap.querySelector<HTMLElement>(".mp-stage")!;
  let token = 0;

  const render = (d: MapDef) => {
    const my = ++token;
    const info = d.random;
    wrap.querySelector(".mp-name")!.textContent = d.name;
    wrap.querySelector(".mp-meta")!.innerHTML =
      `<b>#${esc(info?.code ?? "")}</b> · ${BIOME_ICON[d.biome]} ${cap(BIOME_FR[d.biome])}` +
      (info ? ` · ${esc(cap(info.layout.replace(/-/g, " ")))}` : "") +
      ` · ${d.size}×${d.size}`;
    wrap.querySelector(".mp-blurb")!.textContent = d.blurb;
    wrap.querySelector(".mp-stats")!.innerHTML = statChips(d);
    setZoom(false);
    stage.querySelector("canvas")?.remove();
    stage.querySelector(".mp-marks")?.remove();
    stage.classList.add("busy");
    // paint after the overlay (or the new header) is on screen: ~1.4 Mpx takes a moment on a phone
    requestAnimationFrame(() =>
      setTimeout(() => {
        if (my !== token || !wrap.isConnected) return;
        let cv: HTMLCanvasElement | null = null;
        try {
          cv = paintCanvas(d);
        } catch (e) {
          console.warn("map preview paint failed:", d.id, e);
        }
        if (cv) {
          cv.className = "mp-img";
          stage.prepend(cv);
        }
        stage.insertAdjacentHTML("beforeend", markersSvg(d));
        stage.classList.remove("busy");
      }, 0)
    );
  };

  // zoom: tap toggles fit ↔ 2× around the tapped point; zoomed, the view scrolls (drag with a mouse)
  let zoomed = false;
  function setZoom(on: boolean, cx?: number, cy?: number): void {
    const vr = view.getBoundingClientRect();
    const sr = stage.getBoundingClientRect();
    const fx = cx === undefined ? 0.5 : (cx - sr.left) / sr.width;
    const fy = cy === undefined ? 0.5 : (cy - sr.top) / sr.height;
    zoomed = on;
    view.classList.toggle("zoomed", on);
    if (!on) return void (view.scrollLeft = view.scrollTop = 0);
    const w = stage.offsetWidth;
    view.scrollLeft = fx * w - (cx === undefined ? vr.width / 2 : cx - vr.left);
    view.scrollTop = fy * w - (cy === undefined ? vr.height / 2 : cy - vr.top);
  }
  let down: { id: number; x: number; y: number; sl: number; st: number; moved: boolean } | null = null;
  view.addEventListener("pointerdown", (e) => {
    down = { id: e.pointerId, x: e.clientX, y: e.clientY, sl: view.scrollLeft, st: view.scrollTop, moved: false };
  });
  view.addEventListener("pointermove", (e) => {
    if (!down || down.id !== e.pointerId) return;
    const dx = e.clientX - down.x;
    const dy = e.clientY - down.y;
    if (Math.hypot(dx, dy) > 8) down.moved = true;
    // (touch scrolls natively; a mouse drags the zoomed map around)
    if (zoomed && e.pointerType === "mouse" && e.buttons & 1) {
      view.scrollLeft = down.sl - dx;
      view.scrollTop = down.st - dy;
    }
  });
  view.addEventListener("pointercancel", () => (down = null));
  view.addEventListener("pointerup", (e) => {
    const tap = down && down.id === e.pointerId && !down.moved;
    down = null;
    if (tap && !stage.classList.contains("busy")) setZoom(!zoomed, e.clientX, e.clientY);
  });
  view.addEventListener(
    "wheel",
    (e) => {
      // wheel up (or a trackpad pinch out) zooms in at the cursor; a pinch in, zoomed, zooms back out
      if (!zoomed && e.deltaY < 0) {
        e.preventDefault();
        setZoom(true, e.clientX, e.clientY);
      } else if (zoomed && e.ctrlKey && e.deltaY > 0) {
        e.preventDefault();
        setZoom(false);
      }
    },
    { passive: false }
  );

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  window.addEventListener("keydown", onKey, true);
  let closed = false;
  function close(): void {
    if (closed) return;
    closed = true;
    token++;
    if (closeOpen === close) closeOpen = null;
    window.removeEventListener("keydown", onKey, true);
    wrap.remove();
    hooks.onClose?.();
  }
  wrap.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (t === wrap) return close(); // (a tap on the backdrop)
    const a = t.closest<HTMLElement>("[data-a]")?.dataset.a;
    if (a === "close") close();
    else if (a === "reroll") render(hooks.onReroll());
    else if (a === "play") {
      close();
      hooks.onPlay();
    }
  });
  closeOpen = close;
  render(def);
  wrap.querySelector<HTMLElement>('[data-a="play"]')!.focus({ preventScroll: true });
  return close;
}
