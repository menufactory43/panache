// Les comptes de Panache (README.md « Comptes »), sans Cloudflare : ce qui se vérifie en fonctions pures, pour que les
// tests les passent sous Node (tests/relay-comptes.test.ts). index.ts les applique aux requêtes et à la base D1.
//
// Un compte est créé sans rien demander au premier lancement du jeu : un identifiant et un jeton tirés au hasard.
// Le jeu garde les deux ; la base ne garde que l'empreinte du jeton (SHA-256), jamais le jeton lui-même. Chaque
// requête d'un compte porte « Authorization: Bearer <id>.<jeton> » (un jeton par appareil, table jetons). Le compte tient la sauvegarde du joueur (sa
// progression, src/game/save.ts côté jeu) ; plus tard son classement. Aucune adresse, aucun nom, aucun e-mail.

import { origineAdmise } from "./salon";

/** La sauvegarde la plus lourde admise (une carrière complète pèse quelques Ko). */
export const SAUVEGARDE_MAX = 64 * 1024;

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const JETON = /^[A-Za-z0-9_-]{43}$/;

/** 32 octets tirés au hasard, en base64url (43 caractères). */
export function nouveauJeton(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** L'empreinte d'un jeton, ce que la base garde (hexadécimal). */
export async function empreinte(jeton: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(jeton)));
  return [...h].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** Le compte et le jeton d'un en-tête « Bearer <id>.<jeton> », ou null. */
export function lireAuth(entete: string | null): { id: string; jeton: string } | null {
  const m = entete?.match(/^Bearer ([^.\s]+)\.(\S+)$/);
  if (!m || !ID.test(m[1]!) || !JETON.test(m[2]!)) return null;
  return { id: m[1]!, jeton: m[2]! };
}

/** Les en-têtes CORS pour une origine admise (le jeu publié, l'app, le développement) ; aucun pour les autres. */
export function enTetesCors(origin: string | null): Record<string, string> {
  if (!origin || !origineAdmise(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, PUT, POST, DELETE, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-max-age": "86400",
    vary: "Origin"
  };
}

export type Envoi = { ok: true; base: number; donnees: string } | { ok: false; statut: number; raison: string };

/**
 * Le corps d'un envoi de sauvegarde : `{"rev": <la révision sur laquelle le jeu a fusionné>, "donnees": {…}}`.
 * La révision sert à ne jamais écraser un envoi plus récent d'un autre appareil (index.ts répond 409 avec l'actuelle).
 */
export function lireEnvoi(texte: string): Envoi {
  if (texte.length > SAUVEGARDE_MAX) return { ok: false, statut: 413, raison: "sauvegarde trop lourde" };
  let o: unknown;
  try {
    o = JSON.parse(texte);
  } catch {
    return { ok: false, statut: 400, raison: "JSON attendu" };
  }
  const e = o as { rev?: unknown; donnees?: unknown };
  if (!e || typeof e !== "object" || !Number.isInteger(e.rev) || (e.rev as number) < 0) return { ok: false, statut: 400, raison: "rev attendue" };
  if (!e.donnees || typeof e.donnees !== "object" || Array.isArray(e.donnees)) return { ok: false, statut: 400, raison: "donnees attendues" };
  return { ok: true, base: e.rev as number, donnees: JSON.stringify(e.donnees) };
}
