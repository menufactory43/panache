/**
 * The battle viewer's panel (dev builds only, with src/game/replay.ts): the
 * clock and a seek bar, jumps of 30 s, whose eyes to look through (the whole
 * field, blue's fog or red's), a "thinking…" line while a live battle waits
 * on its next round, the divergence warning, and each commander's orders and
 * notes for the round on screen.
 */
import type { GameScene } from "../game/GameScene";
import type { ReplayFeed } from "../game/replay";
import { clock, pinnedLink } from "../game/replay";
import type { Faction } from "../sim/types";

export interface ReplayPanel {
  update(): void;
  destroy(): void;
}

const CSS = `
#replay-panel { position: fixed; top: 56px; left: 50%; transform: translateX(-50%); z-index: 40; width: min(760px, calc(100vw - 32px));
  font: 13px/1.35 system-ui, sans-serif; color: #e8eef5; pointer-events: none; }
#replay-panel .rp-bar { pointer-events: auto; display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; padding: 6px 10px;
  background: rgba(12, 18, 26, 0.82); border-radius: 10px; backdrop-filter: blur(4px); }
#replay-panel .rp-vs { flex: 1 1 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#replay-panel .blue { color: #7ec1ff; font-weight: 600; } #replay-panel .red { color: #ff8a7a; font-weight: 600; }
#replay-panel input[type=range] { flex: 1 1 160px; min-width: 120px; }
#replay-panel button { font: inherit; color: inherit; background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.18);
  border-radius: 6px; padding: 2px 8px; cursor: pointer; }
#replay-panel button.on { background: rgba(126, 193, 255, 0.35); }
#replay-panel .rp-time { font-variant-numeric: tabular-nums; }
#replay-panel .rp-crest { width: 18px; height: 18px; object-fit: contain; vertical-align: -4px; margin-right: 3px; }
#replay-panel .rp-status, #replay-panel .rp-warn { margin-top: 4px; padding: 3px 10px; border-radius: 8px; background: rgba(12, 18, 26, 0.75); width: fit-content; }
#replay-panel .rp-warn { background: rgba(140, 30, 20, 0.85); }
#replay-panel .rp-warn a { pointer-events: auto; color: inherit; font-weight: 600; }
#replay-panel .rp-notes { pointer-events: auto; margin-top: 6px; display: grid; grid-template-columns: 1fr 1fr; gap: 6px; max-height: 38vh; overflow: auto; }
#replay-panel .rp-side { background: rgba(12, 18, 26, 0.8); border-radius: 10px; padding: 6px 8px; overflow-wrap: anywhere; }
#replay-panel .rp-side h4 { margin: 0 0 3px; font-size: 12px; }
#replay-panel .rp-side pre { margin: 2px 0; white-space: pre-wrap; font: 11px/1.3 ui-monospace, monospace; color: #c9d4df; }
#replay-panel .rp-radio { font-style: italic; color: #ffe8a3; }
@media (max-width: 640px) { #replay-panel .rp-notes { grid-template-columns: 1fr; } }
`;

export function replayPanel(feed: ReplayFeed, scene: GameScene): ReplayPanel {
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
  const root = document.createElement("div");
  root.id = "replay-panel";
  const r = feed.record;
  root.innerHTML = `
    <div class="rp-bar">
      <div class="rp-vs">${crest(r, "blue")}<span class="blue">Bleu</span> ${esc(feed.labels.blue)} contre ${crest(r, "red")}<span class="red">Rouge</span> ${esc(feed.labels.red)} · ${esc(r.map)} graine ${esc(String(r.seed))}</div>
      <span class="rp-time"></span>
      <input type="range" min="0" step="1" value="0" aria-label="Position">
      <button data-jump="-300" title="Reculer de 30 s">−30s</button><button data-jump="300" title="Avancer de 30 s">+30s</button>
      <button data-fog="off" title="Tout le champ de bataille">Tout</button><button data-fog="blue" title="Vue du camp Bleu">Vue Bleu</button><button data-fog="red" title="Vue du camp Rouge">Vue Rouge</button>
      <button data-notes title="Ordres et notes">Notes</button>
    </div>
    <div class="rp-status" hidden></div>
    <div class="rp-warn" hidden></div>
    ${asPlayed(r) ? `<div class="rp-status rp-upgraded">${esc(asPlayed(r)!)}</div>` : ""}
    <div class="rp-notes" hidden><div class="rp-side" data-side="blue"></div><div class="rp-side" data-side="red"></div></div>`;
  document.body.appendChild(root);
  const $ = <T extends HTMLElement>(s: string) => root.querySelector<T>(s)!;
  const time = $("span.rp-time");
  const seek = $<HTMLInputElement>("input[type=range]");
  const status = $(".rp-status");
  const warn = $(".rp-warn");
  const notes = $(".rp-notes");
  let dragging = false;
  seek.addEventListener("input", () => (dragging = true));
  seek.addEventListener("change", () => {
    dragging = false;
    scene.seek(Number(seek.value));
  });
  for (const b of root.querySelectorAll<HTMLButtonElement>("[data-jump]"))
    b.addEventListener("click", () => scene.seek(Math.min(feed.playedTo, scene.tick + Number(b.dataset.jump))));
  const fogButtons = [...root.querySelectorAll<HTMLButtonElement>("[data-fog]")];
  for (const b of fogButtons)
    b.addEventListener("click", () => {
      const v = b.dataset.fog;
      scene.setFog(v === "blue" || v === "red" ? v : null);
    });
  $("[data-notes]").addEventListener("click", (e) => {
    notes.hidden = !notes.hidden;
    (e.currentTarget as HTMLElement).classList.toggle("on", !notes.hidden);
  });

  let shownRound = -1;
  let shownDrift: number | null = null;
  const sideHtml = (side: Faction, round: number) => {
    // the latest round this side actually played, at or before the one on screen
    let l = null;
    for (let k = round; k >= 0 && !l; k--) l = feed.logFor(k, side);
    if (!l) return `<h4 class="${side}">${SIDE[side]}</h4><pre>(rien pour l'instant)</pre>`;
    const orders = l.orders.length ? l.orders.map((o) => JSON.stringify(o)).join("\n") : "(aucun ordre)";
    return (
      `<h4 class="${side}">${SIDE[side]} · manche ${l.round}${l.round !== round ? " (en attente depuis)" : ""}${l.ended && l.ended !== "end_round" ? ` · ${esc(l.ended)}` : ""}</h4>` +
      (l.radio ? `<div class="rp-radio">“${esc(l.radio)}”</div>` : "") +
      `<pre>${esc(orders)}</pre><pre>${esc(l.results.join("\n"))}</pre><pre>${esc(l.notes)}</pre>`
    );
  };

  return {
    update() {
      const t = scene.tick;
      const end = feed.playedTo;
      time.textContent = `${clock(t)} / ${clock(end)}${feed.record.end ? "" : " …"}`;
      seek.max = String(end);
      if (!dragging) seek.value = String(t);
      const fog = scene.fogShown();
      for (const b of fogButtons) b.classList.toggle("on", (b.dataset.fog === "off" && !fog) || b.dataset.fog === fog);
      // a live battle caught up with: the commanders are still on the next round
      const waiting = feed.follow && !feed.record.end && t >= end;
      status.hidden = !waiting;
      if (waiting) status.textContent = `Manche ${feed.roundAt(t)} : les commandants réfléchissent… ${clock(((performance.now() - feed.grewAt) / 1000) * 10)}`;
      // where this version of the game plays the battle differently: found ahead (checkAhead), or as it played
      const drift = feed.divergedAt ?? feed.driftsAt;
      warn.hidden = drift === null;
      if (drift !== null && drift !== shownDrift) {
        shownDrift = drift;
        const pinned = pinnedLink(feed);
        warn.innerHTML =
          `⚠ Cette rediffusion diverge à ${clock(drift)} : ce que tu vois ensuite n'a pas eu lieu` +
          (pinned ? ` · <a href="${esc(pinned)}">▶ La voir en ${esc(feed.record.version!)}</a>` : "");
      }
      const round = feed.roundAt(Math.max(0, t - 1));
      if (!notes.hidden && round !== shownRound) {
        shownRound = round;
        for (const side of ["blue", "red"] as const) $(`.rp-side[data-side=${side}]`).innerHTML = sideHtml(side, round);
      } else if (notes.hidden) shownRound = -1;
    },
    destroy() {
      root.remove();
      style.remove();
    }
  };
}

/**
 * A record re-simulated on newer game code (tools/arena.ts upgrade) whose
 * ending moved: what really happened, so the replay isn't taken for it.
 */
function asPlayed(r: ReplayFeed["record"]): string | null {
  const was = r.upgraded?.[0]?.end;
  const now = r.end;
  // (an ending a few ticks off isn't worth a note)
  if (!was || (was.winner === now?.winner && Math.abs(was.tick - (now?.tick ?? 0)) < 10)) return null;
  const how = was.winner ? `${SIDE[was.winner]} a gagné à ${clock(was.tick)}` : `c'était un match nul à ${clock(was.tick)}`;
  return `Re-simulé sur une version plus récente, la fin diffère : en vrai, ${how}`;
}

/** A side's crest when it played a nation (public/assets/ui/crest-*.webp), else nothing. */
function crest(r: ReplayFeed["record"], side: Faction): string {
  const n = r.nations?.[side];
  return n ? `<img class="rp-crest" src="assets/ui/crest-${n}.webp" alt="" draggable="false">` : "";
}

/** A side's name as the player reads it. */
const SIDE: Record<Faction, string> = { blue: "Bleu", red: "Rouge" };

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
