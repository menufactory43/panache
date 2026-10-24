/**
 * Anonymous counters (relay/README.md « Statistiques »): how many visits and
 * what is played, never who. One beacon to the duel relay on a visit, when a
 * match starts and when one is banked: no id, no cookie. Only the published game
 * counts (and the iPhone app, « app:ios » once a day): the dev server, robots (the smoke test and the tools) and every
 * other page send nothing, and the relay drops what doesn't come from the
 * published page.
 */
import { isCampaignOp } from "../sim/ops";
import { isApp } from "../native";
import { gameMode, isDuelMatch } from "./mode";

const STAT_URL = "https://panache-relais.meffysto.workers.dev/stat";
const silent = (): boolean => import.meta.env.DEV || navigator.webdriver === true;

const SEEN_KEY = "panache.stats.vu";
const DAY_KEY = "panache.stats.jour";

/** The layout the hub uses on this screen (ui/qg.css), as the counters name it. */
function screenKind(): string {
  const w = innerWidth;
  const h = innerHeight;
  if (w <= h) return w / h >= 0.65 && w < 560 ? "duo" : w >= 560 && h >= 800 ? "tablette" : "portrait";
  return h <= 500 ? "paysage" : w >= 860 && h >= 560 ? "large" : "paysage";
}

/**
 * Count the visit, at boot (published game only): every page load
 * (« visite:page »), the first of the day on this device (« visite:jour »,
 * with its screen, « ecran:… ») and the very first (« visite:nouveau »). The
 * device keeps only a date and a flag, to know whether it was counted; nothing
 * identifies it.
 */
export function countVisit(): void {
  if (silent() || (location.hostname !== "menufactory43.github.io" && !isApp)) return;
  track("visite:page");
  try {
    const day = new Date().toISOString().slice(0, 10);
    if (localStorage.getItem(DAY_KEY) !== day) {
      localStorage.setItem(DAY_KEY, day);
      track("visite:jour");
      track(`ecran:${screenKind()}`);
      if (isApp) track("app:ios");
    }
    if (!localStorage.getItem(SEEN_KEY)) {
      localStorage.setItem(SEEN_KEY, "1");
      track("visite:nouveau");
    }
  } catch {
    /* storage blocked: the page view is counted, nothing more */
  }
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
