// Le classement de Panache (README.md « Classement »), sans Cloudflare : la cote, les noms, l'appariement et le
// dépouillement des résultats, en fonctions pures (tests/relay-classement.test.ts). index.ts et le Durable Object
// File les appliquent.
//
// Une seule échelle, le duel normal (ni Éclair ni mutateurs), sur une carte tirée au sort. Une cote Elo qui part de
// 1000. Deux joueurs ne se rencontrent que s'ils jouent la même version du duel (build) et que leurs cotes sont assez
// proches, l'écart admis s'élargissant à mesure qu'ils attendent.

/** La cote d'un joueur neuf. */
export const COTE_DEPART = 1000;
/** Les cartes du classement (src/sim/maps.ts). */
export const CARTES_CLASSEES = ["proving-grounds", "riverlands", "dune-sea", "frostbite", "ashlands", "archipelago"] as const;

const TITRES = ["Aspirant", "Sergent", "Lieutenant", "Capitaine", "Commandant", "Colonel", "Major"];
const NOMS = [
  "Moreau", "Dubois", "Lefebvre", "Girard", "Bonnet", "Mercier", "Lambert", "Fontaine", "Rousseau", "Vincent",
  "Muller", "Faure", "André", "Blanc", "Guérin", "Boyer", "Garnier", "Chevalier", "François", "Legrand",
  "Gauthier", "Perrin", "Robin", "Clément", "Morin", "Nicolas", "Henry", "Roussel", "Mathieu", "Gautier",
  "Masson", "Marchand", "Duval", "Denis", "Dumont", "Marie", "Lemaire", "Noël", "Meyer", "Dufour",
  "Meunier", "Brun", "Blanchard", "Giraud", "Joly", "Rivière", "Lucas", "Brunet", "Gaillard", "Barbier",
  "Arnaud", "Martinez", "Gérard", "Roche", "Renard", "Schmitt", "Roy", "Leroux", "Colin", "Vidal",
  "Caron", "Picard", "Roger", "Fabre"
];

const hache = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h >>> 0;
};

/** Le nom d'un joueur, tiré de son compte (toujours le même) : « Lieutenant Moreau 17 ». */
export function nomDe(compte: string): string {
  const h = hache(compte);
  return `${TITRES[h % TITRES.length]} ${NOMS[(h >>> 4) % NOMS.length]} ${10 + ((h >>> 12) % 90)}`;
}

/** Ce qu'un joueur gagne ou perd de cote : `score` 1 victoire, 0,5 nul, 0 défaite. Plus vite au début. */
export function variation(moi: number, lui: number, score: 0 | 0.5 | 1, joues: number): number {
  const attendu = 1 / (1 + 10 ** ((lui - moi) / 400));
  const k = joues < 10 ? 40 : 24;
  return Math.round(k * (score - attendu));
}

export interface Attente {
  /** La connexion (WebSocket) qui attend. */
  ws: string;
  compte: string;
  cote: number;
  build: number;
  /** Depuis quand il attend (ms). */
  depuis: number;
}

/** L'écart de cote admis après tant d'attente : 100, puis 50 de plus toutes les 5 s, jusqu'à 600. */
export function ecartAdmis(attenteMs: number): number {
  return Math.min(600, 100 + 50 * Math.floor(Math.max(0, attenteMs) / 5000));
}

/** Les paires à lancer : les plus anciens d'abord, chacun avec le plus proche qui convient aux deux. */
export function apparier(file: Attente[], now: number): [Attente, Attente][] {
  const libres = [...file].sort((a, b) => a.depuis - b.depuis);
  const paires: [Attente, Attente][] = [];
  const pris = new Set<string>();
  for (const a of libres) {
    if (pris.has(a.ws)) continue;
    let meilleur: Attente | null = null;
    for (const b of libres) {
      if (b.ws === a.ws || pris.has(b.ws) || b.compte === a.compte || b.build !== a.build) continue;
      const ecart = Math.abs(a.cote - b.cote);
      // (celui qui attend depuis le plus longtemps fixe l’écart admis)
      if (ecart > ecartAdmis(now - Math.min(a.depuis, b.depuis))) continue;
      if (!meilleur || ecart < Math.abs(a.cote - meilleur.cote)) meilleur = b;
    }
    if (meilleur) {
      pris.add(a.ws).add(meilleur.ws);
      paires.push([a, meilleur]);
    }
  }
  return paires;
}

export type Issue = "blue" | "red" | "draw";
export const issueAdmise = (v: unknown): v is Issue => v === "blue" || v === "red" || v === "draw";

/**
 * Ce que disent les deux rapports d'une partie : l'issue retenue, ou null s'il faut attendre (ou s'ils se
 * contredisent). Un joueur qui se dit perdant est cru tout de suite ; un vainqueur autoproclamé attend l'autre,
 * ou que l'autre se taise assez longtemps (il est parti : abandon).
 */
export function depouiller(r: { bleu: Issue | null; rouge: Issue | null }, silencieux: boolean): Issue | null {
  const { bleu, rouge } = r;
  if (bleu && rouge) return bleu === rouge ? bleu : null;
  if (bleu === "red") return "red";
  if (rouge === "blue") return "blue";
  if (silencieux) return bleu ?? rouge;
  return null;
}
