/**
 * A duel's in-match overlays and its report section (DUEL.md "Pause, resign,
 * leave, background", "MatchFeed and GameScene"). The feed decides what
 * shows (src/versus/feed.ts); this only draws it, mounted into the HUD root
 * next to the game's own widgets.
 *
 * - One pill for a stall: "Waiting for your friend…", "…to load", "Friend
 *   paused", "Your friend isn't responding", "Connection lost", with "Leave
 *   (no result)" once the feed offers it (two taps: a stray one doesn't end
 *   the match). Small pills for "Orders queued", "Resigning…" and
 *   "Leaving…". The battlefield stays in view: a stalled match is still
 *   worth looking at.
 * - The report's Duel block: the record, the link's quality, and the end
 *   check ("Checking sync…" until the friend's end report arrives); "Your
 *   friend is back in the lobby: tap Rematch" (DUEL.md "Rematch > Waiting").
 *
 * Text is set as text (nothing here is markup from the air). Styles live in
 * ./hud.css, which ships with the duel chunk.
 *
 * Where the spec is silent:
 *  - "Friend paused" also covers a friend that switched apps: a frame has one
 *    paused bit, and a hidden page pauses (session.ts), so the pill says
 *    "or switched away" under it;
 *  - the stall pill sits under the banner's slot (--banner-top), centred on
 *    the battlefield, and on a phone between the zoom stack and the
 *    calldowns: in short landscape under a 53px banner, and in the banner's
 *    slot itself once Leave shows (hud.css).
 */
import "./hud.css";
import type { ReportSection } from "../ui/report";
import { tr } from "../lang";

/**
 * A stall the player sees: the friend is loading, paused, or simply not heard ("lost" past 5 s); online, this
 * phone's own connection is down ("offline") or the friend's has left the room ("gone").
 */
export type StallKind = "wait" | "load" | "paused" | "lost" | "offline" | "gone";

export interface OverlayState {
  stall: { kind: StallKind; leave: boolean } | null;
  /** The pending queue holds more than 2 s of orders. */
  queued: boolean;
  /** A resign is on its way (it lands D ticks after the tap). */
  resigning: boolean;
  /** Menu or Rematch was tapped: the end goes out for up to 2 s first. */
  leaving: boolean;
}

export interface OverlayHooks {
  /** "Leave (no result)", from the stall pill. */
  leave(): void;
}

export interface DuelOverlay {
  update(s: OverlayState): void;
  destroy(): void;
}

const STALL_TEXT: Record<StallKind, { text: string; sub: string | null }> = {
  wait: { text: tr("En attente de ton ami…", "Waiting for your friend…"), sub: null },
  load: { text: tr("Ton ami charge la partie…", "Your friend is loading the match…"), sub: null },
  paused: { text: tr("Ton ami a mis en pause", "Your friend paused"), sub: tr("ou a changé d'appli", "or switched apps") },
  lost: { text: tr("Ton ami ne répond plus…", "Your friend isn't responding…"), sub: tr("La connexion est peut-être lente", "The connection may be slow") },
  offline: { text: tr("Connexion perdue : reconnexion…", "Connection lost: reconnecting…"), sub: tr("Vérifie ton réseau", "Check your network") },
  gone: { text: tr("Ton ami s'est déconnecté", "Your friend disconnected"), sub: tr("Il a une minute pour revenir", "They have a minute to come back") }
};

export function mountDuelOverlay(root: HTMLElement, hooks: OverlayHooks): DuelOverlay {
  const stack = document.createElement("div");
  stack.className = "duel-ov";
  // (the edge arrows steer around it: ui/awareness.ts)
  stack.dataset.edgeAvoid = "";
  stack.innerHTML = `
    <div class="duel-pill duel-stall" hidden><b></b><small hidden></small><button class="duel-leave" hidden></button></div>
    <div class="duel-pill duel-small duel-queued" hidden>${tr("Ordres en attente", "Orders pending")}</div>
    <div class="duel-pill duel-small duel-resigning" hidden>${tr("Abandon…", "Resigning…")}</div>
    <div class="duel-pill duel-small duel-leaving" hidden>${tr("Départ…", "Leaving…")}</div>`;
  root.appendChild(stack);

  const q = <T extends HTMLElement>(el: HTMLElement, sel: string) => el.querySelector<T>(sel)!;
  const stall = q(stack, ".duel-stall");
  const stallText = q(stall, "b");
  const stallSub = q(stall, "small");
  const stallLeave = q<HTMLButtonElement>(stall, ".duel-leave");
  const queued = q(stack, ".duel-queued");
  const resigning = q(stack, ".duel-resigning");
  const leaving = q(stack, ".duel-leaving");

  // keep these touches off the battlefield
  stack.addEventListener("pointerdown", (e) => e.stopPropagation());
  /** Leave asks twice: the first tap arms it for 3 s. */
  let armedUntil = 0;
  const leaveTap = (btn: HTMLButtonElement) => {
    const now = performance.now();
    if (now < armedUntil) {
      armedUntil = 0;
      hooks.leave();
      return;
    }
    armedUntil = now + 3000;
    btn.textContent = tr("Touche encore pour quitter", "Tap again to leave");
  };
  stallLeave.addEventListener("click", () => leaveTap(stallLeave));

  let last = "";
  return {
    update(s) {
      const armed = performance.now() < armedUntil;
      const key = JSON.stringify(s) + armed;
      if (key === last) return;
      last = key;
      // (the end screen covers a stall: only the leaving pill is worth showing over it)
      stall.hidden = !s.stall || s.leaving;
      if (s.stall) {
        const t = STALL_TEXT[s.stall.kind];
        stallText.textContent = t.text;
        stallSub.hidden = !t.sub;
        stallSub.textContent = t.sub ?? "";
        stall.classList.toggle("bad", s.stall.kind === "lost" || s.stall.kind === "offline" || s.stall.kind === "gone");
      }
      stallLeave.hidden = !s.stall?.leave;
      if (!armed) stallLeave.textContent = tr("Quitter (sans résultat)", "Leave (no result)");
      queued.hidden = !s.queued || s.leaving;
      resigning.hidden = !s.resigning || s.leaving;
      leaving.hidden = !s.leaving;
    },
    destroy() {
      stack.remove();
    }
  };
}

// --------------------------------------------------------------- report ---

/** What the report's Duel block shows, read afresh while the report is up. */
export interface DuelReportView {
  /** The record line ("3 wins · 1 loss · 0 draws"), or null on a practice link. */
  record: string | null;
  /** The end check: "pending" shows "Checking sync…". */
  sync: "pending" | "ok" | "unverified" | "desync" | "left" | "lost";
  /** The friend's reloaded page is in the lobby: "tap Rematch". */
  friendInLobby: boolean;
  /**
   * The link's quality: packets heard, stall time, and the order delay as a
   * player feels it (Lockstep.orderWait: from the drain to this phone stepping
   * the order, mean and worst; null before any order). Not D × 100 ms, which
   * every order would read and the pause menu already shows. Both leave this
   * phone's own pause out, and both count a friend's (it stalls this phone).
   */
  link: { good: number; bad: number; stallMs: number; orders: { meanMs: number; worstMs: number } | null };
}

const SYNC_TEXT: Record<DuelReportView["sync"], { text: string; cls: string }> = {
  pending: { text: tr("Vérification de la synchro…", "Checking sync…"), cls: "pending" },
  ok: { text: tr("Synchro OK ✓", "Sync OK ✓"), cls: "ok" },
  unverified: { text: tr("Non vérifié", "Unverified"), cls: "pending" },
  desync: { text: tr("Désynchronisé : partie nulle", "Out of sync: match void"), cls: "bad" },
  left: { text: tr("Ton ami est parti : sans résultat", "Your friend left: no result"), cls: "bad" },
  lost: { text: tr("Tu es parti : sans résultat", "You left: no result"), cls: "bad" }
};

const secs = (ms: number) => (ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`);
/** Under a second in ms, then in seconds. */
const span = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : secs(ms));

/** The order delay's rows: "Order delay" "620 ms average" and "Slowest order" "1.4 s" ("–" before any order). */
export function orderRows(o: DuelReportView["link"]["orders"]): [string, string][] {
  return [
    [tr("Délai des ordres", "Order delay"), o ? tr(`${span(o.meanMs)} en moyenne`, `${span(o.meanMs)} on average`) : "–"],
    [tr("Ordre le plus lent", "Slowest order"), o ? span(o.worstMs) : "–"]
  ];
}

function syncLine(v: DuelReportView): string {
  const t = SYNC_TEXT[v.sync];
  return `<p class="duel-sync ${t.cls}">${t.text}</p>`;
}

/** What changes while the report is up: the end check, the friend back in the lobby. */
function liveLines(v: DuelReportView): string {
  const back = v.friendInLobby ? `<p class="duel-back">${tr("Ton ami est de retour dans le salon : touche Revanche", "Your friend is back in the lobby: tap Rematch")}</p>` : "";
  return syncLine(v) + back;
}

function recordLine(v: DuelReportView): string {
  // (a practice link keeps no record)
  return v.record === null
    ? `<p class="duel-rec">${tr("Liaison d'entraînement : aucun bilan enregistré", "Practice link: no record kept")}</p>`
    : tr(`<p class="duel-rec">Ton bilan en ligne : <b>${v.record}</b></p>`, `<p class="duel-rec">Your online record: <b>${v.record}</b></p>`);
}

/**
 * The report's Duel block (addReportSection): the end check first (it
 * changes while the report is up), "Your friend is back in the lobby" when
 * it applies, the record, then the link. `view` is read when the report
 * renders and every 250 ms after, until the report goes.
 */
export function duelReportSection(view: () => DuelReportView): ReportSection {
  return {
    id: "duel",
    // (first in the left column: right under the result, where "Checking sync…" is seen)
    order: 5,
    col: "left",
    render: () => {
      const v = view();
      const l = v.link;
      return `<h3 class="duel-h">${tr("🌐 Duel en ligne", "🌐 Online Duel")}</h3>
        <div class="duel-live">${liveLines(v)}${recordLine(v)}</div>
        <table class="duel-link">
          <tr><td>${tr("Paquets reçus", "Packets received")}</td><td>${tr(`${l.good} bons · ${l.bad} mauvais`, `${l.good} good · ${l.bad} bad`)}</td></tr>
          <tr><td>${tr("Attente de la liaison", "Waiting on the link")}</td><td>${secs(l.stallMs)}</td></tr>
          ${orderRows(l.orders).map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("")}
        </table>`;
    },
    mount: (el) => {
      const live = el.querySelector<HTMLElement>(".duel-live");
      if (!live) return;
      let shown = live.innerHTML;
      const timer = window.setInterval(() => {
        if (!el.isConnected) return window.clearInterval(timer);
        const v = view();
        const html = liveLines(v) + recordLine(v);
        if (html !== shown) live.innerHTML = shown = html;
      }, 250);
    }
  };
}
