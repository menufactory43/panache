/**
 * The player's language: French (the game's own) or English.
 *
 * Chosen once, as the page loads: the one picked in the Réglages, else the
 * link's (`?lang=en`: the English share link /en/ lands here with it), else
 * the phone's (French for a French-speaking phone, English for any other). Every
 * table and screen reads LANG when it is built, so switching language saves
 * the pick and reloads the page.
 *
 * Text is written in place, both languages side by side: `tr("Reprendre",
 * "Resume")`. Display only: nothing translated is compared, sent, saved or
 * hashed, so a French player and an English one play the same duel
 * (tests/lang.test.ts checks the worlds stay bit for bit the same).
 * Outside a browser (tests, tools) the language is French unless
 * PANACHE_LANG says otherwise.
 * Engine-free.
 */

export type Lang = "fr" | "en";

export const LANG_KEY = "panache.lang";

const isLang = (v: unknown): v is Lang => v === "fr" || v === "en";

/** The saved pick, else the link's `?lang=`, else the phone's languages (the first French or English one), else English; French outside a browser. */
export function detectLang(env: { saved?: string | null; link?: string | null; languages?: readonly string[]; override?: string } = browserLangEnv()): Lang {
  if (isLang(env.override)) return env.override;
  if (isLang(env.saved)) return env.saved;
  if (isLang(env.link)) return env.link;
  if (!env.languages) return "fr";
  for (const l of env.languages) {
    const base = l.toLowerCase().split("-")[0];
    if (isLang(base)) return base;
  }
  return "en";
}

function browserLangEnv(): { saved?: string | null; link?: string | null; languages?: readonly string[]; override?: string } {
  // (Node: tests and tools, whose navigator and localStorage are no player's)
  const node = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  if (node || typeof navigator === "undefined" || typeof localStorage === "undefined") return { override: node?.env?.PANACHE_LANG };
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(LANG_KEY);
  } catch {
    /* storage unavailable: the phone's language */
  }
  const link = typeof location === "undefined" ? null : new URLSearchParams(location.search).get("lang");
  return { saved, link, languages: navigator.languages?.length ? navigator.languages : [navigator.language] };
}

/** The language this page runs in. */
export const LANG: Lang = detectLang();
export const EN = LANG === "en";

/** The player's language's version: `tr("Reprendre", "Resume")`, `tr(frenchTable, englishTable)`. */
export function tr<T>(fr: T, en: T): T {
  return EN ? en : fr;
}

/** Save a language pick and reload into it. */
export function switchLang(lang: Lang): void {
  if (lang === LANG) return;
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch {
    return; // (nowhere to keep it: the reload would come back in the same language)
  }
  location.reload();
}

if (typeof document !== "undefined") document.documentElement.lang = LANG;
