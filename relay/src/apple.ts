// « Se connecter avec Apple » (README.md « Comptes ») : le jeton qu'Apple signe dans l'app iPhone, vérifié ici en
// fonctions pures (tests/relay-apple.test.ts). index.ts va chercher les clés publiques d'Apple et rattache le compte.
//
// Le jeton est un JWT RS256 : signé par une des clés d'https://appleid.apple.com/auth/keys, émis par Apple, pour
// l'app (aud), pas encore expiré. Son « sub » est l'identifiant stable du joueur chez Apple pour cette équipe : le
// même sur tous ses appareils, c'est lui qui retrouve le compte. Son « nonce » est l'identifiant du compte qui le
// présente (le jeu le met dans la demande à Apple) : un jeton intercepté ne sert à aucun autre compte.

export const APPLE_EMETTEUR = "https://appleid.apple.com";
export const APPLE_CLES = "https://appleid.apple.com/auth/keys";
/** L'app iPhone (capacitor.config.ts). */
export const APPLE_APP = "io.github.menufactory43.panache";

export interface CleApple {
  kid: string;
  kty: string;
  alg?: string;
  n: string;
  e: string;
}

const b64 = (s: string): Uint8Array<ArrayBuffer> => {
  const t = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(t + "=".repeat((4 - (t.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0)) as Uint8Array<ArrayBuffer>;
};
const lireJson = (s: string): Record<string, unknown> | null => {
  try {
    const o = JSON.parse(new TextDecoder().decode(b64(s)));
    return o && typeof o === "object" ? o : null;
  } catch {
    return null;
  }
};

/** Le « sub » d'un jeton d'Apple valable pour ce compte, ou la raison du refus. */
export async function verifierJetonApple(
  jwt: string,
  cles: CleApple[],
  compte: string,
  now: number,
  app = APPLE_APP
): Promise<{ ok: true; sub: string } | { ok: false; raison: string }> {
  const parts = typeof jwt === "string" ? jwt.split(".") : [];
  if (parts.length !== 3) return { ok: false, raison: "jeton illisible" };
  const [h, p, sig] = parts as [string, string, string];
  const tete = lireJson(h);
  const corps = lireJson(p);
  if (!tete || !corps) return { ok: false, raison: "jeton illisible" };
  if (tete.alg !== "RS256") return { ok: false, raison: "algorithme" };
  const cle = cles.find((k) => k.kid === tete.kid && k.kty === "RSA");
  if (!cle) return { ok: false, raison: "clé inconnue" };
  let bon = false;
  try {
    const k = await crypto.subtle.importKey("jwk", { kty: "RSA", n: cle.n, e: cle.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    bon = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", k, b64(sig), new TextEncoder().encode(`${h}.${p}`));
  } catch {
    bon = false;
  }
  if (!bon) return { ok: false, raison: "signature" };
  if (corps.iss !== APPLE_EMETTEUR) return { ok: false, raison: "émetteur" };
  const aud = corps.aud;
  if (!(aud === app || (Array.isArray(aud) && aud.includes(app)))) return { ok: false, raison: "destinataire" };
  const t = now / 1000;
  if (typeof corps.exp !== "number" || corps.exp < t) return { ok: false, raison: "expiré" };
  if (typeof corps.iat === "number" && corps.iat > t + 300) return { ok: false, raison: "du futur" };
  if (corps.nonce !== compte) return { ok: false, raison: "pour un autre compte" };
  if (typeof corps.sub !== "string" || !corps.sub || corps.sub.length > 128) return { ok: false, raison: "sans sub" };
  return { ok: true, sub: corps.sub };
}
