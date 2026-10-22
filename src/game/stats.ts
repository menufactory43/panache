/**
 * Anonymous play counters (relay/README.md « Statistiques »): what is played,
 * never who. One beacon to the duel relay when a match starts and when one is
 * banked: no id, no cookie, nothing stored here. Only the published game
 * counts: the dev server, robots (the smoke test and the tools) and every
 * other page send nothing, and the relay drops what doesn't come from the
 * published page.
 */
import { isCampaignOp } from "../sim/ops";
import { gameMode, isDuelMatch } from "./mode";

const STAT_URL = "https://panache-relais.meffysto.workers.dev/stat";
/**
 * Visits: Cloudflare Web Analytics (cookieless). The site's token from the
 * dashboard (Web Analytics → menufactory43.github.io); empty: no beacon.
 */
const WEB_ANALYTICS_TOKEN = "";

const silent = (): boolean => import.meta.env.DEV || navigator.webdriver === true;

/** Load the visit beacon once, at boot (published game only). */
export function countVisit(): void {
  if (!WEB_ANALYTICS_TOKEN || silent() || location.hostname !== "menufactory43.github.io") return;
  const s = document.createElement("script");
  s.defer = true;
  s.src = "https://static.cloudflareinsights.com/beacon.min.js";
  s.dataset.cfBeacon = JSON.stringify({ token: WEB_ANALYTICS_TOKEN });
  document.head.appendChild(s);
}

/** What kind of match the menu is about to start, as the counters name it. */
export function matchKind(): string {
  if (isDuelMatch()) return "duel";
  if (gameMode.spectator) return "ia";
  const op = gameMode.op;
  if (op) return op.tutorial ? "instruction" : isCampaignOp(op) ? "campagne" : "epreuve";
  if (gameMode.daily) return "jour";
  return gameMode.mode === "survival" ? "survie" : "escarmouche";
}

/** Count one event (« partie:escarmouche », « fin:campagne:victoire », « nation:empire »). */
export function track(e: string): void {
  if (silent() || !navigator.sendBeacon) return;
  try {
    navigator.sendBeacon(`${STAT_URL}?e=${encodeURIComponent(e)}`);
  } catch {
    /* a counter never gets in the way */
  }
}
