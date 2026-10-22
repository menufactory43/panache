// Les statistiques de Panache, sans Cloudflare : ce qui se compte (README.md « Statistiques »), en fonctions pures pour
// que les tests les vérifient sous Node (tests/relay-stats.test.ts). Le Durable Object Stats (index.ts) ne fait
// qu'additionner.
//
// Des compteurs par jour, rien d'autre : combien de visites (« visite:jour »), sur quel écran (« ecran:portrait »),
// quoi est joué (« partie:escarmouche », « fin:campagne:victoire », « nation:empire »), jamais qui. Pas d'identifiant,
// pas d'adresse, pas de cookie.

/** Un événement : deux ou trois mots en minuscules (« genre:quoi[:issue] »). */
const EVENT = /^(visite|ecran|partie|fin|nation|duel):[a-z]{2,16}(:[a-z]{2,16})?$/;

/** Les jours gardés (le ménage efface les plus vieux). */
export const JOURS_GARDES = 120;
/** Au plus tant de jours par lecture. */
export const JOURS_MAX = 120;

export function evenementAdmis(e: unknown): e is string {
  return typeof e === "string" && e.length <= 40 && EVENT.test(e);
}

/** Le jour UTC d'un instant : « 2026-10-22 ». */
export function jourDe(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** La clé de stockage d'un compteur. */
export const cleDe = (jour: string, e: string): string => `${jour}|${e}`;

/** Les jours d'une lecture, du plus ancien au plus récent (aujourd'hui compris). */
export function joursDepuis(now: number, n: number): string[] {
  const k = Math.max(1, Math.min(JOURS_MAX, Math.floor(n) || 1));
  return Array.from({ length: k }, (_, i) => jourDe(now - (k - 1 - i) * 86_400_000));
}

/** Les compteurs stockés (clé → nombre) rangés par jour : { "2026-10-22": { "partie:escarmouche": 3 } }. */
export function parJour(entrees: Iterable<[string, number]>): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const [cle, n] of entrees) {
    const [jour, e] = cle.split("|");
    if (!jour || !e) continue;
    (out[jour] ??= {})[e] = n;
  }
  return out;
}

/** Le jour à partir duquel tout est effacé (exclu des jours gardés). */
export const limiteMenage = (now: number): string => jourDe(now - JOURS_GARDES * 86_400_000);
