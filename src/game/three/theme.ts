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
