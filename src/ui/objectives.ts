import { TICK_RATE } from "../sim/balance";
import { isVisible } from "../sim/fog";
import { dropLandTick } from "../sim/objectives";
import type { Faction, World } from "../sim/types";
import { buildingCenter, hqOf } from "../sim/world";

/**
 * The top-bar objectives pill, beside the clock: one pip per Uplink in its
 * holder's colour (nearest to your base first; pulsing while someone is
 * capturing it), then the supply-drop timer — the next drop's countdown,
 * gold while one is inbound, and how long landed crates have left.
 */

export interface ObjectivePill {
  update(): void;
  destroy(): void;
}

const clock = (ticks: number) => {
  const s = Math.max(0, Math.ceil(ticks / TICK_RATE));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export function createObjectivePill(world: World, player: Faction, spectator: boolean): ObjectivePill | null {
  const o = world.objectives;
  const bar = document.querySelector<HTMLElement>("#hud .topbar");
  if (!bar || (o.uplinks.length === 0 && o.dropSites.length === 0)) return null;
  const el = document.createElement("div");
  el.className = "objpill";
  el.innerHTML = `<span class="ol" title="Relais TSF"><b>📡</b><span class="pips"></span></span><span class="lf" title="Une Montgolfière gratuite est en route" hidden></span><span class="od" title="Largages de ravitaillement"></span>`;
  bar.appendChild(el);
  const pipsEl = el.querySelector<HTMLElement>(".pips")!;
  const dropEl = el.querySelector<HTMLElement>(".od")!;
  const lifeEl = el.querySelector<HTMLElement>(".lf")!;
  let lastLife = "";
  if (o.uplinks.length === 0) el.querySelector<HTMLElement>(".ol")!.hidden = true;
  if (o.dropSites.length === 0) dropEl.hidden = true;
  // pips run from our side of the map to theirs (with no HQ, under Nomads: from our corner, blue's
  // bottom left or red's top right, as the maps are mirrored)
  const side = spectator ? "blue" : player;
  const hq = hqOf(world, side);
  const home = hq ? buildingCenter(hq) : side === "red" ? { x: world.width, y: 0 } : { x: 0, y: world.height };
  const order = [...o.uplinks].sort(
    (a, b) => Math.hypot(a.x - home.x, a.y - home.y) - Math.hypot(b.x - home.x, b.y - home.y)
  );
  let lastPips = "";
  let lastDrop = "";

  function update(): void {
    // (an island relay held with no troops on it pays nothing: a hollow pip — for the enemy's,
    // only while we can see it: whether they've left one empty is theirs to hide)
    const idle = (l: (typeof order)[number]) =>
      !!(l.infantryOnly && l.owner && !l.crewed) &&
      (spectator || l.owner === player || isVisible(world, player, Math.floor(l.x), Math.floor(l.y)));
    const pips = order
      .map((l) => `${l.owner ?? "none"}${l.pushing || l.contested ? "*" : ""}${idle(l) ? "o" : ""}`)
      .join(",");
    if (pips !== lastPips) {
      lastPips = pips;
      pipsEl.innerHTML = order
        .map((l) => `<i class="pip ${l.owner ?? ""} ${l.pushing || l.contested ? "busy" : ""} ${idle(l) ? "idle" : ""}"></i>`)
        .join("");
      const held = o.uplinks.filter((l) => l.owner === player);
      const unmanned = held.filter(idle).length;
      el.title = `Relais : tu en tiens ${held.length} sur ${o.uplinks.length}${unmanned ? ` (${unmanned} sans troupes : ne rapporte rien)` : ""}`;
    }
    // a free replacement Condor on its way (lifeline.ts)
    const due = spectator ? null : world.lifeline?.[player]?.due ?? null;
    const life = due === null ? "" : `🚁 ${clock(due - world.tick)}`;
    if (life !== lastLife) {
      lastLife = life;
      lifeEl.hidden = life === "";
      lifeEl.textContent = life;
    }
    if (o.dropSites.length === 0) return;
    let text: string;
    let cls: string;
    const landed = o.crates.filter((c) => world.tick >= c.landTick);
    const inbound = o.crates.filter((c) => world.tick < c.landTick);
    if (inbound.length > 0) {
      text = `📦 ${clock(inbound[0]!.landTick - world.tick)}`;
      cls = "od hot";
    } else if (landed.length > 0) {
      const left = Math.min(...landed.map((c) => c.expireTick - world.tick));
      text = `📦×${landed.length} ${clock(left)}`;
      cls = "od live";
    } else {
      // the next drop's landing (it's announced 10 s before)
      text = `📦 ${clock(dropLandTick(o.drops) - world.tick)}`;
      cls = "od";
    }
    const key = text + cls;
    if (key !== lastDrop) {
      lastDrop = key;
      dropEl.textContent = text;
      dropEl.className = cls;
    }
  }
  update();
  return {
    update,
    destroy: () => el.remove()
  };
}
