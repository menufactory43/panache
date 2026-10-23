/**
 * « La Campagne de 1900 »: the silent film around each mission (PANACHE-CONCEPTION.md §2.3).
 * The intro film's engine (title.ts / title.css): black intertitles in the gold Art Nouveau
 * frame, film grain, flicker and scratches, the projector's clatter (audio-title.ts) and an
 * iris — plus, for a chapter's first mission, its still in sepia under a Ken Burns drift.
 *
 * Each card holds CARD_MS; a tap moves on to the next, « Passer › » (or Échap) ends the reel.
 * Robots (navigator.webdriver) and prefers-reduced-motion get no film: onDone runs at once.
 */
import { projectorStart } from "../game/audio-title";
import { FILMFX, fleuron, grain, ornament } from "./title";
import "./campaign.css";
import { tr } from "../lang";

const CARD_MS = 2600;
const STILL_MS = 2800;
const IRIS = 650;

export interface Reel {
  /** The intertitles, in order (12 words at most each). */
  cards: string[];
  /** A small line over the first card (« Acte I — L'Ultimatum · Mission 1 »). */
  kicker?: string;
  /** The chapter's still (assets/ui/campaign/<art>.webp), shown before the first card. */
  art?: string;
  /** The tone of the reel's end: a victory, a defeat (the cards' colour), or neutral. */
  tone?: "win" | "lose";
  /** The last cards are the campaign's « FIN »: bigger type, slower. */
  finale?: number;
  onDone(): void;
}

/** Is there a film to show here (not for a robot, nor under reduced motion)? */
export const filmOn = (): boolean =>
  typeof document !== "undefined" && navigator.webdriver !== true && !matchMedia("(prefers-reduced-motion: reduce)").matches;

const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);

/** Play a reel over everything; returns a function that cuts it short. */
export function playReel(r: Reel): () => void {
  if (!filmOn() || r.cards.length === 0) {
    r.onDone();
    return () => undefined;
  }
  const el = document.createElement("div");
  el.className = `cine${r.tone ? ` cine-${r.tone}` : ""}`;
  const fin = r.finale ?? 0;
  const cards = r.cards.map((t, i) => {
    const big = i >= r.cards.length - fin;
    const kick = i === 0 && r.kicker ? `<small class="cine-kick">${esc(r.kicker)}</small>` : "";
    return `<div class="fl-part fl-card${big ? " cine-fin" : ""}"><div class="fc-frame"><i class="fc-c tl">${ornament}</i><i class="fc-c tr">${ornament}</i><i class="fc-c bl">${ornament}</i><i class="fc-c br">${ornament}</i>${kick}${fleuron}<p>${esc(t)}</p>${fleuron}</div></div>`;
  });
  const still = r.art ? `<div class="fl-part fl-shot cine-still"><img class="fl-pic" src="assets/ui/campaign/${r.art}.webp" alt="" draggable="false" /></div>` : "";
  el.innerHTML = `<div class="fl-gate">${still}${cards.join("")}</div><div class="fl-fx">${FILMFX}</div><button class="fl-skip" type="button">${tr("Passer ›", "Skip ›")}</button>`;
  document.body.appendChild(el);
  grain(el);
  const parts = [...el.querySelectorAll<HTMLElement>(".fl-part")];
  const stop = projectorStart(0.32);
  let i = -1;
  let timer = 0;
  let done = false;
  const end = () => {
    if (done) return;
    done = true;
    window.clearTimeout(timer);
    stop();
    window.removeEventListener("keydown", key, true);
    el.classList.add("out");
    window.setTimeout(() => el.remove(), 420);
    r.onDone();
  };
  const show = (k: number) => {
    i = k;
    window.clearTimeout(timer);
    if (k >= parts.length) return end();
    const p = parts[k]!;
    for (const q of parts) q.classList.remove("on", "card-in", "iris-in", "iris-out");
    p.classList.add("on", p.classList.contains("fl-shot") ? "iris-in" : "card-in");
    const ms = p.classList.contains("fl-shot") ? STILL_MS : p.classList.contains("cine-fin") ? CARD_MS * 1.4 : CARD_MS;
    if (p.classList.contains("fl-shot")) {
      const pic = p.querySelector<HTMLElement>(".fl-pic")!;
      pic.animate([{ transform: "scale(1.04) translate(0, 0)" }, { transform: "scale(1.14) translate(-2%, -1.5%)" }], { duration: ms + IRIS, easing: "ease-out", fill: "both" });
      timer = window.setTimeout(() => {
        p.classList.add("iris-out");
        timer = window.setTimeout(() => show(k + 1), IRIS);
      }, ms - IRIS);
      return;
    }
    // the last card irises out
    timer = window.setTimeout(() => {
      if (k === parts.length - 1) {
        p.classList.add("iris-out");
        timer = window.setTimeout(() => show(k + 1), IRIS);
      } else show(k + 1);
    }, ms);
  };
  const key = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      end();
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      show(i + 1);
    }
  };
  window.addEventListener("keydown", key, true);
  el.addEventListener("pointerdown", (e) => e.stopPropagation());
  el.addEventListener("click", (e) => {
    e.stopPropagation();
    show(i + 1);
  });
  el.querySelector(".fl-skip")!.addEventListener("click", (e) => {
    e.stopPropagation();
    end();
  });
  show(0);
  return end;
}
