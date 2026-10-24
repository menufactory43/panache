// La logique du relais de Panache, sans Cloudflare : ce qu'un salon décide (qui entre, ce qui passe), en fonctions pures
// pour que les tests la vérifient sous Node (tests/online-relay.test.ts). Le Durable Object (index.ts) ne fait que
// l'appliquer à ses WebSockets et à son stockage.
//
// Un salon = un code de 4 lettres = deux places : l'hôte et l'invité. Chaque place est tenue par une clé (tirée au
// hasard par le jeu, gardée dans son sessionStorage) : celui qui revient avec la même clé dans la minute reprend sa
// place (un tunnel, un changement de réseau, la Revanche qui recharge la page) ; quelqu'un qui devine le code ne peut
// ni la prendre ni mettre l'autre dehors.

/** Les rôles tels que le relais les nomme (le jeu dit host / guest). */
export type Role = "hote" | "invite";

/** Les lettres d'un code : pas de I ni de O, qu'on confond avec 1 et 0 au téléphone. */
export const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ";
export const CODE = /^[A-Z]{4}$/;

/** Une place quittée reste à son joueur ce temps-là (ms) : la fenêtre de reconnexion. */
export const RECONNEXION_MS = 60_000;
/** Un salon ne vit pas plus longtemps que ça (ms), même occupé. */
export const VIE_MAX_MS = 12 * 3600_000;
/** Taille maximale d'un message (caractères) : un paquet du jeu en fait une quarantaine. */
export const MESSAGE_MAX = 512;
/** Débit : un seau de jetons par connexion (le jeu envoie 5 à 10 paquets par seconde). */
export const DEBIT_PAR_S = 40;
export const DEBIT_RAFALE = 80;
/** Taille maximale d'une clé de place. */
export const CLE_MAX = 64;

/** Les codes de fermeture que le relais envoie (le jeu les lit dans CloseEvent.code). */
export const FERME = {
  /** Remplacé par une nouvelle connexion du même joueur. */
  remplace: 4000,
  /** Origine refusée. */
  origine: 4003,
  /** Pas de salon sous ce code (personne n'héberge). */
  inconnu: 4004,
  /** La place est prise par quelqu'un d'autre : salon complet. */
  complet: 4009,
  /** L'hôte veut créer un salon sous un code déjà pris : il en tire un autre. */
  pris: 4010,
  /** Le salon a expiré. */
  expire: 4011,
  /** Trop de messages. */
  abus: 4008
} as const;

/** Une place : la clé de son joueur, quand on l'a vu pour la dernière fois (ms), et s'il est branché. */
export interface Place {
  cle: string;
  vu: number;
}

/** Ce que le salon garde (stockage du Durable Object). */
export interface Etat {
  /** Création du salon (ms), pour VIE_MAX_MS. */
  cree: number | null;
  hote: Place | null;
  invite: Place | null;
}

export const autre = (r: Role): Role => (r === "hote" ? "invite" : "hote");

/** Une place compte tant que son joueur est branché, ou parti depuis moins de RECONNEXION_MS. */
export function tenue(p: Place | null, branche: boolean, now: number): boolean {
  return branche || (!!p && now - p.vu < RECONNEXION_MS);
}

export type Admission = { ok: true } | { ok: false; code: number; raison: string };

/**
 * Qui entre. `nouveau` : l'hôte crée le salon (il refuse un code déjà en usage, le jeu en tire un autre) ; sans lui,
 * l'hôte reprend sa place (sa clé). Un invité n'entre que dans un salon dont l'hôte tient sa place, et dans une place
 * libre ou la sienne. `branches` : les rôles qui ont une connexion ouverte en ce moment.
 */
export function admettre(
  e: Etat,
  role: Role,
  cle: string,
  nouveau: boolean,
  branches: ReadonlySet<Role>,
  now: number
): Admission {
  if (e.cree !== null && now - e.cree >= VIE_MAX_MS) return { ok: false, code: FERME.expire, raison: "salon expiré" };
  const hote = tenue(e.hote, branches.has("hote"), now);
  const invite = tenue(e.invite, branches.has("invite"), now);
  if (role === "hote") {
    if (nouveau) {
      // (un code en usage, ou la même clé qui recrée : une seconde tentative après une coupure au tout début)
      if ((hote && e.hote?.cle !== cle) || (!hote && invite)) return { ok: false, code: FERME.pris, raison: "code pris" };
      return { ok: true };
    }
    if (!hote) return { ok: false, code: FERME.inconnu, raison: "salon fermé" };
    if (e.hote?.cle !== cle) return { ok: false, code: FERME.complet, raison: "place prise" };
    return { ok: true };
  }
  if (!hote) return { ok: false, code: FERME.inconnu, raison: "salon introuvable" };
  if (invite && e.invite?.cle !== cle) return { ok: false, code: FERME.complet, raison: "salon complet" };
  return { ok: true };
}

/** L'état après l'entrée de `role` (admis). Un hôte qui crée efface ce qui restait d'un salon expiré. */
export function entrer(e: Etat, role: Role, cle: string, nouveau: boolean, now: number): Etat {
  const base: Etat = role === "hote" && nouveau && e.hote?.cle !== cle ? { cree: now, hote: null, invite: null } : { ...e, cree: e.cree ?? now };
  return { ...base, [role]: { cle, vu: now } };
}

/** L'état après le départ (la connexion fermée) de `role` : sa place lui reste RECONNEXION_MS. */
export function sortir(e: Etat, role: Role, now: number): Etat {
  const p = e[role];
  return p ? { ...e, [role]: { ...p, vu: now } } : e;
}

/**
 * Quand le salon doit se réveiller pour faire le ménage (ms), ou null : rien à attendre. Branché, la fin de vie ;
 * personne, la fin de la dernière fenêtre de reconnexion (et le salon est vidé à ce moment-là).
 */
export function prochainReveil(e: Etat, branches: ReadonlySet<Role>): number | null {
  if (e.cree === null) return null;
  const fin = e.cree + VIE_MAX_MS;
  if (branches.size > 0) return fin;
  const vus = [e.hote, e.invite].filter((p): p is Place => !!p).map((p) => p.vu + RECONNEXION_MS);
  return vus.length ? Math.min(fin, Math.max(...vus)) : null;
}

/** Le salon n'a plus de raison d'être : personne de branché ni d'attendu, ou trop vieux. */
export function perime(e: Etat, branches: ReadonlySet<Role>, now: number): boolean {
  if (e.cree === null) return true;
  if (now - e.cree >= VIE_MAX_MS) return true;
  return !tenue(e.hote, branches.has("hote"), now) && !tenue(e.invite, branches.has("invite"), now);
}

/** Les messages du jeu qui passent : un paquet ("p<bits> …") d'une taille raisonnable. Le reste (le JSON du relais : "{…") est jeté. */
export function relayable(msg: unknown): msg is string {
  // ("p" puis un chiffre : le nombre de bits du paquet ; « ping » a sa réponse automatique et n'arrive pas ici)
  return typeof msg === "string" && msg.length > 2 && msg.length <= MESSAGE_MAX && msg.charCodeAt(0) === 0x70 && msg.charCodeAt(1) >= 0x30 && msg.charCodeAt(1) <= 0x39;
}

/** Un seau de jetons : `prendre` dit si un message de plus passe. */
export class Seau {
  private jetons = DEBIT_RAFALE;
  private t: number;
  /** Messages refusés d'affilée. */
  refus = 0;
  constructor(now: number) {
    this.t = now;
  }
  prendre(now: number): boolean {
    this.jetons = Math.min(DEBIT_RAFALE, this.jetons + ((now - this.t) / 1000) * DEBIT_PAR_S);
    this.t = now;
    if (this.jetons < 1) {
      this.refus++;
      return false;
    }
    this.jetons--;
    this.refus = 0;
    return true;
  }
}

/** L’app iPhone : la page embarquée par Capacitor (capacitor.config.ts à la racine). */
export const APP_IPHONE = "capacitor://localhost";

/**
 * Les origines admises : la page publiée, l’app iPhone (Capacitor, `capacitor://localhost`), et le développement (localhost, et une adresse du réseau local pour
 * essayer sur un téléphone). Pas d'Origin du tout (un outil, un test sous Node) : admis, ce n'est pas un navigateur.
 */
export function origineAdmise(origin: string | null): boolean {
  if (origin === null || origin === "") return true;
  if (origin === "https://menufactory43.github.io" || origin === APP_IPHONE) return true;
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const h = u.hostname;
  if (h === "localhost" || h === "127.0.0.1" || h === "[::1]") return true;
  return /^(10\.\d+|192\.168|172\.(1[6-9]|2\d|3[01]))\.\d+\.\d+$/.test(h);
}

/** Le code d'une adresse /salon/ABCD (insensible à la casse), ou null. */
export function codeDe(pathname: string): string | null {
  const m = pathname.match(/^\/salon\/([A-Za-z]{4})\/?$/);
  return m ? m[1]!.toUpperCase() : null;
}
