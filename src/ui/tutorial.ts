/**
 * L'Instruction's overlay (src/game/tutorial.ts decides, src/game/tutorial-view.ts
 * observes): one walnut-and-brass bubble with the one instruction, a gloved
 * hand that taps exactly the control to use (or mimes the gesture), a pulsing
 * brass ring round it, the pennant over the flag, and a "Passer" link. Plus
 * the menu's first-launch prompt. Belle Époque styling: src/ui/tutorial.css.
 *
 * Nothing here takes a touch except the bubble's own buttons: the hand, ring
 * and pennant let every tap through to the control or battlefield beneath.
 */
import { openSheet } from "./career";
import { tr } from "../lang";

/** A rectangle on screen (CSS px). */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A gloved hand pointing up, fingertip at (22, 2) in a 48×64 box; brass cuff below. */
const GLOVE = `<svg viewBox="0 0 48 64" aria-hidden="true">
  <path d="M17 6c0-3 2.4-5 5-5s5 2 5 5v18c1-1.6 2.6-2.4 4.4-2.2 2 .2 3.4 1.8 3.6 3.6 1-1 2.4-1.5 3.8-1.2 2 .4 3.2 2.1 3.2 4v2.4c.9-.6 2-.8 3.1-.5 1.7.5 2.9 2 2.9 3.8V44c0 7-5.2 12-12.6 12H26c-5.3 0-9-2.6-11.6-7L7.6 37.4c-1-1.8-.5-4 1.2-5.1 1.8-1.2 4.2-.8 5.5.9L17 37z" fill="#fbf6ea" stroke="#2a1906" stroke-width="2" stroke-linejoin="round"/>
  <path d="M27 24v9M35 26v8M41.6 30v5" fill="none" stroke="#2a1906" stroke-width="1.6" stroke-linecap="round" opacity=".55"/>
  <path d="M19 30c-.5-4 0-9 0-9" fill="none" stroke="#b9ab8c" stroke-width="1.2" stroke-linecap="round"/>
  <rect x="15" y="52" width="32" height="11" rx="3" fill="#d9a84f" stroke="#2a1906" stroke-width="2"/>
  <path d="M18 57.5h26" stroke="#fff1c8" stroke-width="1.2" opacity=".7"/>
</svg>`;

/** Fingertip position inside the glove box (CSS px, at the 48×64 size). */
const TIP = { x: 22, y: 2 };

export interface TutOverlay {
  /** The bubble: the instruction (or praise), the step for the pips. */
  say(text: string, opts: { step: number; tone: "do" | "praise" | "end" }): void;
  /** Point at a box (the hand taps its centre; a ring around it). Null hides both. */
  point(target: Box | null, hand: boolean): void;
  /** Mime a gesture in the middle of the battlefield (null: none). */
  gesture(g: "drag" | "pinch" | "wheel" | "keys" | null, at?: { x: number; y: number }): void;
  /** The pennant over the flag (screen point of its foot), or null. */
  flag(at: { x: number; y: number } | null): void;
  /** Fade everything out (the lesson is over). */
  hide(): void;
  destroy(): void;
}

export interface TutOverlayHooks {
  host: HTMLElement;
  /** The lesson's steps (the progress pips). */
  steps: number;
  /** "Passer l'instruction", confirmed. */
  skip(): void;
}

export function mountTutorialOverlay(h: TutOverlayHooks): TutOverlay {
  const root = document.createElement("div");
  root.className = "tuto";
  root.innerHTML = `
    <div class="tu-ring" hidden></div>
    <div class="tu-hand" hidden><div class="tu-glove">${GLOVE}</div></div>
    <div class="tu-gest" hidden></div>
    <div class="tu-flag" hidden><svg viewBox="0 0 40 56" aria-hidden="true"><path d="M8 4v50" stroke="#3a2a12" stroke-width="3" stroke-linecap="round"/><circle cx="8" cy="4" r="3" fill="#f6dc92" stroke="#3a2a12" stroke-width="1.4"/><path d="M10 7c9-3 15 3 26 0v18c-11 3-17-3-26 0z" fill="#2c4f9e" stroke="#16264d" stroke-width="1.4"/><path d="M10 13c9-3 15 3 26 0" stroke="#f2e8d0" stroke-width="3" fill="none" opacity=".85"/><path d="M10 19c9-3 15 3 26 0" stroke="#c0392b" stroke-width="3" fill="none" opacity=".9"/></svg></div>
    <div class="tu-bubble" role="status" aria-live="polite">
      <div class="tu-head"><span class="tu-tag">${tr("Instruction", "Training")}</span><span class="tu-pips"></span><button class="tu-skip" type="button">${tr("Passer", "Skip")}</button></div>
      <p class="tu-text"></p>
      <div class="tu-confirm" hidden><span>${tr("Quitter l'instruction ?", "Quit the training?")}</span><button class="tu-yes" type="button">${tr("Oui", "Yes")}</button><button class="tu-no" type="button">${tr("Non", "No")}</button></div>
    </div>`;
  h.host.appendChild(root);
  const $ = <T extends HTMLElement>(s: string) => root.querySelector<T>(s)!;
  const ring = $(".tu-ring");
  const hand = $(".tu-hand");
  const gest = $(".tu-gest");
  const flagEl = $(".tu-flag");
  const bubble = $(".tu-bubble");
  const textEl = $(".tu-text");
  const pips = $(".tu-pips");
  const confirm = $(".tu-confirm");
  pips.innerHTML = Array.from({ length: h.steps }, () => "<i></i>").join("");
  // the bubble's own buttons are the only touchable parts
  bubble.addEventListener("pointerdown", (e) => e.stopPropagation());
  $(".tu-skip").addEventListener("click", () => {
    confirm.hidden = !confirm.hidden;
  });
  $(".tu-no").addEventListener("click", () => (confirm.hidden = true));
  $(".tu-yes").addEventListener("click", () => h.skip());

  let lastText = "";
  let lastStep = -1;
  let lastTone = "";
  let target: Box | null = null;
  let lastGest: string | null = null;

  /**
   * Where the bubble goes: at the top, unless what it points at is up there
   * under it (then low, over the bottom bar). In landscape with the build
   * drawer open along one side, it sits low in the free part of the field,
   * clear of the drawer and of ⚔ Armée in the opposite corner.
   */
  const placeBubble = () => {
    const W = window.innerWidth;
    const landscape = W > window.innerHeight;
    const sheet = landscape && h.host.classList.contains("bh-sheet-open") ? h.host.querySelector<HTMLElement>(".bh-sheet") : null;
    const sr = sheet?.getBoundingClientRect();
    if (sr && sr.width > 0) {
      const onRight = sr.left > W / 2;
      const corner = 160; // (Armée, or 🔨 and ⚡ for a lefty, in the far bottom corner)
      const x0 = onRight ? corner : sr.right + 12;
      const x1 = onRight ? sr.left - 12 : W - corner;
      const bw = Math.max(240, Math.min(360, x1 - x0));
      bubble.style.left = `${Math.round((x0 + x1) / 2)}px`;
      bubble.style.width = `${Math.round(bw)}px`;
      bubble.classList.add("low", "side");
      return;
    }
    if (bubble.classList.contains("side")) {
      bubble.classList.remove("side");
      bubble.style.left = "";
      bubble.style.width = "";
    }
    const top = landscape ? 8 : 128;
    const bw = bubble.offsetWidth || 340;
    const bh = bubble.offsetHeight || 80;
    const x0 = (W - bw) / 2;
    const under =
      !!target &&
      target.y < top + bh + 28 &&
      target.y + target.h > top - 8 &&
      target.x < x0 + bw + 8 &&
      target.x + target.w > x0 - 8;
    bubble.classList.toggle("low", under);
  };

  return {
    say(text, opts) {
      if (text !== lastText || opts.tone !== lastTone) {
        textEl.textContent = text;
        bubble.dataset.tone = opts.tone;
        // a fresh line pops in
        bubble.classList.remove("pop");
        void bubble.offsetWidth;
        bubble.classList.add("pop");
        lastText = text;
        lastTone = opts.tone;
      }
      if (opts.step !== lastStep) {
        lastStep = opts.step;
        [...pips.children].forEach((el, i) => {
          el.className = i + 1 < opts.step ? "done" : i + 1 === opts.step ? "on" : "";
        });
      }
      root.classList.remove("gone");
    },
    point(box, withHand) {
      target = box;
      placeBubble();
      if (!box) {
        ring.hidden = true;
        hand.hidden = true;
        return;
      }
      const cx = box.x + box.w / 2;
      const cy = box.y + box.h / 2;
      ring.hidden = false;
      if (box.w > box.h * 1.4) {
        // a wide control (the coal pill): a brass capsule round it
        const rw = box.w + 16;
        const rh = box.h + 16;
        ring.style.transform = `translate(${Math.round(cx - rw / 2)}px, ${Math.round(cy - rh / 2)}px)`;
        ring.style.width = `${Math.round(rw)}px`;
        ring.style.height = `${Math.round(rh)}px`;
        ring.style.borderRadius = `${Math.round(rh / 2)}px`;
      } else {
        const r = Math.max(26, Math.min(70, Math.max(box.w, box.h) / 2 + 8));
        ring.style.transform = `translate(${Math.round(cx - r)}px, ${Math.round(cy - r)}px)`;
        ring.style.width = ring.style.height = `${Math.round(r * 2)}px`;
        ring.style.borderRadius = "50%";
      }
      hand.hidden = !withHand;
      if (withHand) {
        // from below pointing up, or from above pointing down near the bottom edge
        const down = cy > window.innerHeight - 170;
        hand.classList.toggle("down", down);
        // (the glove turns about its fingertip: the tip lands on the target either way)
        const hx = cx - TIP.x;
        const hy = cy + (down ? -6 : 6) - TIP.y;
        hand.style.transform = `translate(${Math.round(hx)}px, ${Math.round(hy)}px)`;
      }
    },
    gesture(g, at) {
      gest.hidden = !g;
      if (!g) {
        lastGest = null;
        return;
      }
      if (g !== lastGest) {
        lastGest = g;
        gest.dataset.g = g;
        gest.innerHTML =
          g === "drag"
            ? `<div class="tg-trail"></div><div class="tg-move"><div class="tu-glove">${GLOVE}</div></div>`
            : g === "pinch"
              ? `<div class="tg-pinch"><i class="a"></i><i class="b"></i><div class="tu-glove ga">${GLOVE}</div><div class="tu-glove gb">${GLOVE}</div></div>`
              : g === "wheel"
                ? `<div class="tg-mouse"><svg viewBox="0 0 40 60" aria-hidden="true"><rect x="3" y="3" width="34" height="54" rx="17" fill="#f2e8d0" stroke="#2a1906" stroke-width="2.5"/><path d="M20 3v20M3 23h34" stroke="#2a1906" stroke-width="2"/><rect class="wh" x="16.5" y="9" width="7" height="10" rx="3.5" fill="#d9a84f" stroke="#2a1906" stroke-width="1.5"/></svg><b>⇕</b></div>`
                : `<div class="tg-keys"><kbd class="u">↑</kbd><kbd class="l">←</kbd><kbd class="d">↓</kbd><kbd class="r">→</kbd></div>`;
      }
      const p = at ?? { x: window.innerWidth / 2, y: window.innerHeight / 2 };
      gest.style.left = `${Math.round(p.x)}px`;
      gest.style.top = `${Math.round(p.y)}px`;
    },
    flag(at) {
      flagEl.hidden = !at;
      if (at) flagEl.style.transform = `translate(${Math.round(at.x - 8)}px, ${Math.round(at.y - 54)}px)`;
    },
    hide() {
      root.classList.add("gone");
      ring.hidden = true;
      hand.hidden = true;
      gest.hidden = true;
      flagEl.hidden = true;
    },
    destroy() {
      root.remove();
    }
  };
}

/**
 * The first "Jouer" on this device: "Première fois ? Fais l'instruction (3 min)".
 * `yes` starts it, `no` carries on with what Jouer was going to do.
 */
export function showTutorialPrompt(host: HTMLElement, yes: () => void, no: () => void): void {
  const wrap = openSheet(
    host,
    "tutoprompt",
    `<div class="tp-crest" aria-hidden="true">🎓</div>
     <h2>${tr("Première fois ?", "First time?")}</h2>
     <p class="sh-sub">${tr("Fais l'instruction : un geste à la fois, 3 minutes.", "Take the training: one gesture at a time, 3 minutes.")}</p>
     <div class="sh-actions"><button class="cta alt" id="tp-no">${tr("Non, jouer", "No, play")}</button><button class="cta" id="tp-yes">${tr("Oui, apprendre", "Yes, teach me")}</button></div>`
  );
  let answered = false;
  const answer = (fn: () => void) => () => {
    if (answered) return;
    answered = true;
    wrap.remove();
    fn();
  };
  wrap.querySelector("#tp-yes")!.addEventListener("click", answer(yes));
  wrap.querySelector("#tp-no")!.addEventListener("click", answer(no));
  // (a tap outside just closes it: asked again on the next Jouer)
}

/**
 * 🎓 Instruction on the menu: the two lessons, « Premier jour » (the basics)
 * and « Deuxième jour » (the orders past them), each ticked once done.
 */
export function showTutorialPicker(host: HTMLElement, s: { day1Done: boolean; day2Done: boolean }, start: (day: 1 | 2) => void): void {
  const card = (day: 1 | 2, title: string, sub: string, done: boolean) =>
    `<button class="tp-day${done ? " done" : ""}" data-day="${day}"><b>${title}</b><small>${sub}</small><i>${done ? "✓" : "▶"}</i></button>`;
  const wrap = openSheet(
    host,
    "tutoprompt tutopick",
    `<div class="tp-crest" aria-hidden="true">🎓</div>
     <h2>${tr("Instruction", "Training")}</h2>
     <div class="tp-days">
       ${card(1, tr("Premier jour", "First Day"), tr("Caméra, ordres, construction, pouvoirs · 3 min", "Camera, orders, building, powers · 3 min"), s.day1Done)}
       ${card(2, tr("Deuxième jour", "Second Day"), tr("Sélection rapide, groupes, routes, marche en ordre, repli · 4 min", "Quick selection, groups, routes, marching in order, falling back · 4 min"), s.day2Done)}
     </div>
     <p class="sh-sub">${tr("Tout le reste est dans ? Comment jouer.", "Everything else is in ? How to play.")}</p>`
  );
  wrap.querySelectorAll<HTMLElement>(".tp-day").forEach((b) =>
    b.addEventListener("click", () => {
      wrap.remove();
      start(Number(b.dataset.day) as 1 | 2);
    })
  );
}
