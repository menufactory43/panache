/**
 * The HUD's top band, measured: the pause/mute buttons, the top bar (scrap,
 * clock + speed, and whatever pills a mode adds: Last Stand's wave pill, an
 * op's goal pill, the spectator's versus pill), the battle meter hanging
 * under it, an op's corner pill and the minimap all grow or move by mode and
 * orientation. Instead of fixed offsets, this measures what the band really
 * occupies and places the two things that must sit below it:
 *
 * - the **ticker** (top-left toast stack): below every band widget in its
 *   column. The battle meter's slot is always reserved, so the ticker doesn't
 *   jump whenever a fight starts or ends on screen.
 * - the **banner** (centred over the visible battlefield): below every band
 *   widget across its width. In portrait it keeps clear of one ticker line
 *   (the ticker shows only its newest line while a banner is up), so neither
 *   moves; in landscape there is no height to spare, so the banner sits right
 *   under the top bar and the ticker's newest line steps down beneath it.
 *
 * - the **calldown stack** and the **zoom stack** (portrait: right and left
 *   edges): where they like to be (centred / 38% down), but below a banner's
 *   slot and above the chip row.
 * - the **info card** (portrait): just above the dock, however tall the chip
 *   row and selection panel make it, but never up into the band: when it
 *   doesn't fit between the two it overlaps the dock instead (down to its old
 *   fixed spot).
 *
 * Results are CSS custom properties on the HUD root (`--tick-top`, `--tick-w`,
 * `--banner-top`, `--banner-x`, `--banner-max`, `--pw-top`, `--zoom-top`,
 * `--card-bottom`) and a `tick-under` class;
 * style.css uses them with sensible fallbacks.
 */

interface Box {
  x0: number;
  x1: number;
  bottom: number;
}

/** Gaps kept under the band (and, for the info card, above the dock), CSS px. */
const GAP = { ticker: 6, banner: 8, card: 8 } as const;
/** The portrait info card's old fixed bottom (CSS px): the lowest it goes to stay under the band. */
const CARD_FLOOR = 150;
/** Battle meter size until it has been seen once (it hangs under the top bar). */
const METER_DEFAULT = { w: 156, h: 20, gap: 5 } as const;
/** Height reserved for one ticker line (two text lines) above a portrait banner. */
const TICK_LINE = 48;
/** A banner with a title and up to two sub-lines (portrait), for keeping side widgets clear of it. */
const BANNER_H = 80;

export interface HudLayout {
  /** Re-measure (cheap; throttled unless `force`). Call every frame and on banner changes. */
  refresh(force?: boolean): void;
  /** Ticker top right now (CSS px), for tests/debug. */
  readonly tickTop: number;
  destroy(): void;
}

export function mountHudLayout(root: HTMLElement): HudLayout {
  const q = <T extends HTMLElement = HTMLElement>(sel: string) => root.querySelector<T>(sel);
  const meterSize: { w: number; h: number } = { w: METER_DEFAULT.w, h: METER_DEFAULT.h };
  let lastAt = -Infinity;
  let lastVars = "";
  let tickTop = 0;
  const dirty = () => (lastAt = -Infinity);
  window.addEventListener("resize", dirty);
  window.addEventListener("orientationchange", dirty);

  const shown = (el: HTMLElement | null): el is HTMLElement => {
    if (!el || el.hidden || el.closest("[hidden]")) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const box = (el: HTMLElement): Box => {
    const r = el.getBoundingClientRect();
    return { x0: r.left, x1: r.right, bottom: r.bottom };
  };
  const overlaps = (b: Box, x0: number, x1: number) => b.x0 < x1 && b.x1 > x0;
  const below = (pieces: Box[], x0: number, x1: number, floor: number) =>
    pieces.reduce((y, b) => (overlaps(b, x0, x1) ? Math.max(y, b.bottom) : y), floor);

  function refresh(force = false): void {
    const now = performance.now();
    if (!force && now - lastAt < 200) return;
    lastAt = now;
    const W = window.innerWidth;
    const H = window.innerHeight;
    if (W <= 0 || H <= 0) return;
    const landscape = W > H;
    const tl = q(".tl");
    const topbar = q(".topbar");
    const banner = q("#banner");
    const toasts = q("#toasts");
    if (!tl || !topbar || !banner || !toasts) return;

    // ------------------------------------------------------ the band ---
    const pieces: Box[] = [];
    if (shown(tl)) pieces.push(box(tl));
    if (shown(topbar)) {
      const tb = box(topbar);
      pieces.push(tb);
      // the battle meter's slot under the top bar, reserved whether or not a fight is on
      const meter = q(".bmeter");
      if (shown(meter)) {
        const r = meter.getBoundingClientRect();
        meterSize.w = r.width;
        meterSize.h = r.height;
        pieces.push(box(meter));
      } else {
        const x0 = landscape ? (tb.x0 + tb.x1) / 2 - meterSize.w / 2 : tb.x0;
        pieces.push({ x0, x1: x0 + meterSize.w, bottom: tb.bottom + METER_DEFAULT.gap + meterSize.h });
      }
    }
    for (const sel of [".opspill.corner", ".minimap-wrap"]) {
      const el = q(sel);
      if (shown(el)) pieces.push(box(el));
    }
    // nothing in a column: still below the top row of buttons
    const top0 = shown(tl) ? tl.getBoundingClientRect().bottom : 46;

    // ----------------------------------------------------- the ticker ---
    const left = tl.getBoundingClientRect().left;
    const tickW = Math.round(landscape ? Math.min(W * 0.3, 270) : Math.min(W * 0.62, 300));
    const tick = Math.round(below(pieces, left, left + tickW, top0) + GAP.ticker);

    // ----------------------------------------------------- the banner ---
    // centred over the visible battlefield (left of the landscape sidebar), in
    // landscape on the top bar's own axis (the spectator has no sidebar, but the
    // top bar and minimap keep their places)
    const bar = q(".buildbar");
    const bb = bar && shown(bar) ? bar.getBoundingClientRect() : null;
    // (a drawer waiting off screen, or a lefty's on the left edge, takes nothing off the right)
    const playRight = landscape && bb && bb.width < W - 1 && bb.left > W / 2 && bb.left < W - 1 ? bb.left : W;
    const tr = topbar.getBoundingClientRect();
    let cx = landscape && tr.width > 0 ? (tr.left + tr.right) / 2 : playRight / 2;
    // in landscape the minimap and the calldown block sit level with the banner, on the
    // right: the banner stays left of them (a wide one slides left of centre rather than wrap)
    let right = playRight - 8;
    if (landscape)
      for (const sel of [".minimap-wrap", ".powers"]) {
        const el = q(sel);
        if (shown(el)) right = Math.min(right, el.getBoundingClientRect().left - 8);
      }
    const maxW = Math.max(200, Math.min(520, right - 8));
    root.style.setProperty("--banner-max", `${Math.round(maxW)}px`);
    const bw = banner.hidden ? maxW : Math.min(maxW, banner.offsetWidth || maxW);
    cx = Math.max(8 + bw / 2, Math.min(right - bw / 2, cx));
    let bannerTop = below(pieces, cx - bw / 2, cx + bw / 2, top0) + GAP.banner;
    const meetsTicker = cx - bw / 2 < left + tickW;
    // portrait: one ticker line (its newest, clipped to two text lines) fits between the band and the banner
    if (!landscape && meetsTicker) bannerTop = Math.max(bannerTop, tick + TICK_LINE + GAP.ticker);
    // landscape: the ticker's newest line steps down under a showing banner
    const under = landscape && meetsTicker && banner.classList.contains("in") && !banner.hidden;
    const tickNow = under ? Math.round(bannerTop + banner.offsetHeight + GAP.ticker) : tick;
    tickTop = tickNow;

    // ------------------------------------------- the calldown stack ---
    // portrait: centred on the right edge, but under the banner's slot and above the chip row
    let pwTop = -1;
    let zoomTop = -1;
    let cardBottom = -1;
    if (!landscape) {
      const row = q(".chiprow") ?? q("#chips");
      const floor = row && shown(row) ? row.getBoundingClientRect().top - 8 : H - 8;
      const clear = bannerTop + BANNER_H + GAP.banner;
      // preferred top, pushed below the banner slot, but never into the chip row
      const place = (want: number, h: number) => Math.round(Math.min(Math.max(want, clear), Math.max(floor - h, Math.min(want, clear))));
      const powers = q(".powers");
      if (shown(powers)) pwTop = place(H / 2 - powers.offsetHeight / 2, powers.offsetHeight);
      const zoom = q(".zoombtns");
      if (shown(zoom)) zoomTop = place(H * 0.38, zoom.offsetHeight);
      // the info card opens above the dock, not over half of its chip row; a dock grown
      // tall (a big mixed selection on a short phone) would push it up over the band, so
      // there it overlaps the dock instead, but no lower than its old fixed spot
      const dock = q(".dock");
      if (shown(dock)) {
        cardBottom = H - dock.getBoundingClientRect().top + GAP.card;
        const card = q("#card");
        if (shown(card)) {
          const x0 = W / 2 - card.offsetWidth / 2;
          const fit = H - (below(pieces, x0, x0 + card.offsetWidth, top0) + GAP.card) - card.offsetHeight;
          cardBottom = Math.max(Math.min(cardBottom, fit), Math.min(cardBottom, CARD_FLOOR));
        }
        cardBottom = Math.round(cardBottom);
      }
    }

    const vars = `${tickNow}|${tickW}|${Math.round(bannerTop)}|${Math.round(cx)}|${under}|${pwTop}|${zoomTop}|${cardBottom}`;
    if (vars === lastVars) return;
    lastVars = vars;
    root.style.setProperty("--tick-top", `${tickNow}px`);
    root.style.setProperty("--tick-w", `${tickW}px`);
    root.style.setProperty("--banner-top", `${Math.round(bannerTop)}px`);
    root.style.setProperty("--banner-x", `${Math.round(cx)}px`);
    root.classList.toggle("tick-under", under);
    if (pwTop >= 0) root.style.setProperty("--pw-top", `${pwTop}px`);
    else root.style.removeProperty("--pw-top");
    if (zoomTop >= 0) root.style.setProperty("--zoom-top", `${zoomTop}px`);
    else root.style.removeProperty("--zoom-top");
    if (cardBottom >= 0) root.style.setProperty("--card-bottom", `${cardBottom}px`);
    else root.style.removeProperty("--card-bottom");
  }

  return {
    refresh,
    get tickTop() {
      return tickTop;
    },
    destroy() {
      window.removeEventListener("resize", dirty);
      window.removeEventListener("orientationchange", dirty);
    }
  };
}
