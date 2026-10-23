/**
 * « Tes parties »: the matches kept in the Archives (game/archive.ts), as a
 * list in the hub's 🎬 Archives sheet and the menu's « Voir une
 * rediffusion » sheet: each with ▶ Temps forts (its highlight reel,
 * ui/reel.ts), 🎬 Revoir (the whole match in the battle viewer) and ⬇ (its
 * .json, which plays in any build's viewer). Records load only when picked.
 */
import type { BattleRecord } from "../arena/record";
import { archives, encodeRecord, loadMatch, type ArchiveMeta } from "../game/archive";
import { fmtTime } from "../game/chronicle";
import { recordName } from "../game/reel";
import { isKnownMapId, mapById } from "../sim/maps";
import { tr } from "../lang";

const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);

const RESULT = tr({ win: "Victoire", loss: "Défaite", draw: "Match nul" }, { win: "Victory", loss: "Defeat", draw: "Draw" });
const KIND = tr({ escarmouche: "Escarmouche", quotidienne: "Opération du jour", duel: "Duel" }, { escarmouche: "Skirmish", quotidienne: "Daily Op", duel: "Duel" });

/** One line of the list: « Victoire · Riverlands », « 22 oct. · 7:42 · contre IA Rush (Normal) ». */
export function archiveLine(m: ArchiveMeta): { head: string; sub: string } {
  const map = isKnownMapId(m.map) ? mapById(m.map).name : m.map;
  const d = new Date(m.created);
  const day = isNaN(d.getTime()) ? "" : d.toLocaleDateString(tr("fr-FR", "en-GB"), { day: "numeric", month: "short" });
  const p = m.played;
  return {
    head: `${p ? RESULT[p.result] : tr("Partie", "Match")} · ${map}`,
    sub: [day, fmtTime(m.secs), p ? tr(`${KIND[p.kind]} contre ${p.against}`, `${KIND[p.kind]} vs ${p.against}`) : ""].filter(Boolean).join(" · ")
  };
}

/** Fill `host` with the saved matches (async); `watch` plays one, as its reel or whole. */
export function mountSavedList(host: HTMLElement, watch: (r: BattleRecord, reel: boolean) => Promise<void> | void): void {
  host.classList.add("arch-list");
  host.innerHTML = `<p class="sh-note">${tr("Chargement des archives…", "Loading the archives…")}</p>`;
  void archives()
    .list()
    .then((list) => {
      if (list.length === 0) {
        host.innerHTML = `<p class="sh-note">${tr("Tes parties s'enregistreront ici : les 5 dernières escarmouches et duels, à revoir ou à partager.", "Your matches will be saved here: the last 5 skirmishes and duels, to rewatch or share.")}</p>`;
        return;
      }
      host.innerHTML = list
        .map((m) => {
          const l = archiveLine(m);
          return `<div class="arch-row" data-id="${esc(m.id)}">
            <div class="arch-t"><b>${esc(l.head)}</b><small>${esc(l.sub)}</small></div>
            <div class="arch-b">
              <button class="cta" data-a="reel" type="button" title="${tr("Les temps forts, en film muet", "The highlights, as a silent film")}">${tr("▶ Temps forts", "▶ Highlights")}</button>
              <button class="cta alt" data-a="watch" type="button" title="${tr("Toute la partie", "The whole match")}">${tr("🎬 Revoir", "🎬 Rewatch")}</button>
              <button class="cta alt" data-a="file" type="button" title="${tr("Télécharger la partie (.json)", "Download the match (.json)")}" aria-label="${tr("Télécharger la partie", "Download the match")}">⬇</button>
            </div>
          </div>`;
        })
        .join("");
      host.querySelectorAll<HTMLButtonElement>(".arch-row [data-a]").forEach((b) =>
        b.addEventListener("click", async () => {
          const id = b.closest<HTMLElement>(".arch-row")!.dataset.id!;
          b.disabled = true;
          const r = await loadMatch(archives(), id);
          b.disabled = false;
          if (!r) {
            b.closest(".arch-row")!.querySelector("small")!.textContent = tr("Cette partie est illisible : elle a été effacée ou abîmée.", "This match is unreadable: it was erased or damaged.");
            return;
          }
          if (b.dataset.a === "file") return download(encodeRecord(r), recordName(r.map, r.created));
          await watch(r, b.dataset.a === "reel");
        })
      );
    })
    .catch(() => (host.innerHTML = `<p class="sh-note">${tr("Les archives sont inaccessibles dans ce navigateur.", "The archives are unavailable in this browser.")}</p>`));
}

function download(text: string, name: string): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
}
