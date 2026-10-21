/**
 * Sideways-scrolling card rows (the map picker, the Ops cards). The
 * scrollbar is hidden, so on a phone nothing says more cards wait off
 * screen. This wraps a row so that each side with more to see fades its
 * cards out and shows a tappable chevron, kept in sync as the row scrolls,
 * resizes, is re-rendered or is shown and hidden.
 */
export interface ScrollCue {
  /** Scroll so this card sits in the middle of the row (no-op while the row is hidden). */
  reveal(card: HTMLElement | null, smooth?: boolean): void;
}

export function scrollCue(row: HTMLElement): ScrollCue {
  const wrap = document.createElement("div");
  wrap.className = "hscroll";
  row.parentElement?.insertBefore(wrap, row);
  wrap.appendChild(row);
  const btn = (side: "l" | "r", label: string) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `hs-btn hs-${side}`;
    b.setAttribute("aria-label", label);
    b.textContent = side === "l" ? "‹" : "›";
    b.addEventListener("click", () => row.scrollBy({ left: (side === "l" ? -0.8 : 0.8) * row.clientWidth, behavior: "smooth" }));
    wrap.appendChild(b);
    return b;
  };
  btn("l", "Défiler à gauche");
  btn("r", "Défiler à droite");

  // (the wrapper hides with its row through CSS, in the same layout pass: see .hscroll:has)
  const update = () => {
    const max = row.scrollWidth - row.clientWidth;
    wrap.classList.toggle("more-l", !row.hidden && row.scrollLeft > 4);
    wrap.classList.toggle("more-r", !row.hidden && row.scrollLeft < max - 4);
  };
  row.addEventListener("scroll", update, { passive: true });
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(update).observe(row);
  else window.addEventListener("resize", update);
  new MutationObserver(update).observe(row, { childList: true, attributes: true, attributeFilter: ["hidden"] });
  requestAnimationFrame(update);

  return {
    reveal(card, smooth = false) {
      if (!card || row.hidden || row.clientWidth === 0) return;
      const r = row.getBoundingClientRect();
      const c = card.getBoundingClientRect();
      const left = row.scrollLeft + (c.left + c.width / 2) - (r.left + r.width / 2);
      row.scrollTo({ left: Math.max(0, left), behavior: smooth ? "smooth" : "auto" });
      update();
    }
  };
}
