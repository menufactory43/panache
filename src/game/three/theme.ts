/**
 * Visual theme switch. The fr-belle-epoque branch defaults to the Belle
 * Époque look (brass and bronze, navy and burgundy team colours, gaslight
 * amber, a dirigible for the Scout); `?style=original` brings back the
 * original gunmetal look for comparison.
 */
export const BELLE_EPOQUE: boolean =
  typeof location !== "undefined" && new URLSearchParams(location.search).get("style") !== "original";

// the Belle Époque skin of the interface (src/ui/belle.css) hangs off this class
if (BELLE_EPOQUE && typeof document !== "undefined") document.documentElement.classList.add("belle");

// Which side the Dynamic Island (or notch) is on in landscape: iOS reports the same safe-area inset
// on both sides, so a panel against the other edge would keep an empty margin for nothing.
// html[data-notch="l"|"r"] (none in portrait); src/ui/email-hud.css reads it.
if (BELLE_EPOQUE && typeof window !== "undefined") {
  const notch = () => {
    const a = screen.orientation?.angle ?? Number((window as { orientation?: number }).orientation ?? 0);
    const side = a === 90 ? "l" : a === 270 || a === -90 ? "r" : "";
    if (side) document.documentElement.dataset.notch = side;
    else delete document.documentElement.dataset.notch;
  };
  notch();
  screen.orientation?.addEventListener?.("change", notch);
  window.addEventListener("orientationchange", notch);
  window.addEventListener("resize", notch);
}
