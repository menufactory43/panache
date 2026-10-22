/**
 * The way into a highlight reel (ui/reel.ts, a lazily loaded chunk): the
 * report's « ▶ Revoir les temps forts » block, and the hand-off across the
 * reload it makes. A finished match's scene can't be rebuilt in place (every
 * new match reloads the page), so the button leaves the record in
 * sessionStorage under REEL_KEY — or, when it's too big for that, the id it
 * was kept under in the Archives — and reloads; main.ts takes it at boot
 * (takeReel) and plays the reel instead of the menu.
 */
import type { BattleRecord } from "../arena/record";
import { archives, decodeRecord, encodeRecord, loadMatch, type ArchiveMeta } from "../game/archive";
import { clipsOf, reelMs } from "../game/reel";
import type { ReportSection } from "./report";

/** sessionStorage: the reel the next boot plays, its record's JSON or "id:<archive id>". */
export const REEL_KEY = "panache.reel";

/** The report's block: the button, and how long the reel runs. */
export function reelSection(o: { record: BattleRecord; saved: Promise<ArchiveMeta | null>; leave(): void }): ReportSection {
  const secs = Math.round(reelMs(clipsOf(o.record)) / 1000);
  return {
    id: "reel",
    order: 22,
    col: "left",
    render: () =>
      `<div class="aar-reel"><button class="cta" id="reel-go" type="button">▶ Revoir les temps forts</button><small>${secs} s de film muet, à revoir ou à partager · gardé dans les Archives</small></div>`,
    mount: (el) => {
      const btn = el.querySelector<HTMLButtonElement>("#reel-go");
      btn?.addEventListener("click", async () => {
        btn.disabled = true;
        let token: string | null = null;
        try {
          sessionStorage.setItem(REEL_KEY, encodeRecord(o.record));
          token = "json";
        } catch {
          // (too big for the session, or blocked: by its id in the Archives)
          const meta = await o.saved;
          if (meta)
            try {
              sessionStorage.setItem(REEL_KEY, `id:${meta.id}`);
              token = "id";
            } catch {
              /* blocked */
            }
        }
        if (!token) {
          btn.textContent = "Impossible de garder la partie ici";
          return;
        }
        o.leave();
      });
    }
  };
}

/** The reel this boot was asked for (and forgets the ask): its record, or null. */
export async function takeReel(): Promise<BattleRecord | null> {
  let v: string | null = null;
  try {
    v = sessionStorage.getItem(REEL_KEY);
    sessionStorage.removeItem(REEL_KEY);
  } catch {
    return null;
  }
  if (!v) return null;
  try {
    return v.startsWith("id:") ? await loadMatch(archives(), v.slice(3)) : decodeRecord(v);
  } catch {
    return null;
  }
}

/** Is a reel waiting for this boot? (Read before the menu: it plays instead.) */
export function reelWaiting(): boolean {
  try {
    return !!sessionStorage.getItem(REEL_KEY);
  } catch {
    return false;
  }
}
