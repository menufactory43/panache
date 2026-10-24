// Le relais du duel en ligne de Panache (« Défier un ami (en ligne) », src/versus/online.ts côté jeu).
//
//   wss://panache-relais.<compte>.workers.dev/salon/ABCD?role=hote|invite&cle=<clé>[&nouveau=1]
//
// Un salon par code de 4 lettres, un Durable Object par salon. L'hôte et l'invité s'y branchent ; chaque paquet de
// l'un part tel quel chez l'autre (le jeu fait tout le reste : appairage, lockstep, synchro). Le relais dit aussi à
// chacun quand l'autre arrive ou s'en va ({"t":"pair","on":…}). Une place quittée reste à son joueur une minute
// (reconnexion) ; un salon vide est effacé ensuite, et aucun ne vit plus de 12 h. Deux joueurs au plus, des messages
// courts, un débit borné, et seules la page publiée et le développement local sont admis (salon.ts).
// Hibernation : entre deux messages le salon ne tourne pas, et le « ping » du jeu reçoit son « pong » sans le réveiller.
//
// Il tient aussi les statistiques du jeu (README.md « Statistiques ») : des compteurs par jour de ce qui est joué,
// jamais de qui (stats.ts) ; POST /stat?e=partie:escarmouche les additionne, GET /stats?jours=30 les lit.
//
// Mise en ligne : voir relay/README.md (npx wrangler deploy depuis ce dossier).

import { DurableObject } from "cloudflare:workers";
import {
  APP_IPHONE, FERME, Seau, admettre, autre, codeDe, entrer, origineAdmise, perime, prochainReveil, relayable, sortir, CLE_MAX,
  type Etat, type Role
} from "./salon";
import { APPLE_CLES, verifierJetonApple, type CleApple } from "./apple";
import { CARTES_CLASSEES, apparier, depouiller, issueAdmise, nomDe, variation, type Attente, type Issue } from "./classement";
import { empreinte, enTetesCors, lireAuth, lireEnvoi, nouveauJeton } from "./comptes";
import { cleDe, evenementAdmis, jourDe, joursDepuis, limiteMenage, parJour } from "./stats";

interface Env {
  SALON: DurableObjectNamespace<Salon>;
  STATS: DurableObjectNamespace<Stats>;
  /** Les comptes et leurs sauvegardes (migrations/). */
  DB: D1Database;
  /** Au plus quelques comptes créés par minute et par adresse. */
  CREATION: RateLimit;
  /** La file d'attente des parties classées (un seul objet). */
  FILE: DurableObjectNamespace<FileAttente>;
}

/** Seules la page publiée et l’app iPhone comptent (un développement local, un aperçu ou un outil ne gonflent pas les chiffres). */
const PAGE_PUBLIEE = "https://menufactory43.github.io";

const VIDE: Etat = { cree: null, hote: null, invite: null };

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/") return new Response("Panache — relais du duel en ligne", { headers: { "content-type": "text/plain; charset=utf-8" } });
    if (url.pathname === "/stat" && req.method === "POST") {
      const e = url.searchParams.get("e");
      const origine = req.headers.get("Origin");
      if ((origine !== PAGE_PUBLIEE && origine !== APP_IPHONE) || !evenementAdmis(e)) return new Response(null, { status: 204 });
      return env.STATS.get(env.STATS.idFromName("panache")).fetch(req);
    }
    if (url.pathname === "/stats" && req.method === "GET") return env.STATS.get(env.STATS.idFromName("panache")).fetch(req);
    if (url.pathname === "/compte" || url.pathname.startsWith("/compte/")) return comptes(req, url, env);
    if (url.pathname === "/file") return file(req, url, env);
    if (url.pathname === "/classement" || url.pathname.startsWith("/classement/")) return classement(req, url, env);
    const code = codeDe(url.pathname);
    if (!code) return new Response("introuvable", { status: 404 });
    if (!origineAdmise(req.headers.get("Origin"))) return new Response("origine refusée", { status: 403 });
    if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("websocket attendu", { status: 426 });
    const stub = env.SALON.get(env.SALON.idFromName(code));
    return stub.fetch(req);
  }
};

/** Le compte d'un jeton (« <id>.<jeton> »), ou null. */
async function compteDe(env: Env, auth: { id: string; jeton: string } | null) {
  if (!auth) return null;
  return env.DB.prepare("SELECT c.id, c.cote, c.joues, c.gagnes FROM jetons j JOIN comptes c ON c.id = j.compte WHERE j.empreinte = ? AND j.compte = ?")
    .bind(await empreinte(auth.jeton), auth.id)
    .first<{ id: string; cote: number; joues: number; gagnes: number }>();
}

/**
 * La file d'attente des parties classées : wss://…/file?id=<compte>&jeton=<jeton>&build=<version du duel>. (Une
 * WebSocket ne porte pas d'en-tête Authorization : le jeton passe dans l'adresse, en wss.) Le compte vérifié, la
 * connexion va au Durable Object FileAttente, qui apparie et répond {"t":"adversaire",…} (README.md « Classement »).
 */
async function file(req: Request, url: URL, env: Env): Promise<Response> {
  if (!origineAdmise(req.headers.get("Origin"))) return new Response("origine refusée", { status: 403 });
  if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("websocket attendu", { status: 426 });
  const id = url.searchParams.get("id") ?? "";
  const c = await compteDe(env, lireAuth(`Bearer ${id}.${url.searchParams.get("jeton") ?? ""}`));
  const build = Number(url.searchParams.get("build"));
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
  // (refusé par la WebSocket : un navigateur lit le code de fermeture, pas le statut)
  if (!c || !Number.isInteger(build) || build < 0 || build > 0xffff) {
    server.accept();
    fermer(server, 4001, c ? "version" : "compte inconnu");
    return new Response(null, { status: 101, webSocket: client });
  }
  const fwd = new Request(req.url, req);
  fwd.headers.set("x-compte", c.id);
  fwd.headers.set("x-cote", String(c.cote));
  fwd.headers.set("x-build", String(build));
  return env.FILE.get(env.FILE.idFromName("file")).fetch(fwd);
}

/** Une partie classée est tenue pour finie sans nouvelles de l'un des deux au bout de 20 min (il est parti). */
const SILENCE_MS = 20 * 60_000;

/** Applique l'issue d'une partie aux cotes (une seule fois). */
async function solder(env: Env, p: { id: string; bleu: string; rouge: string }, issue: Issue, now: number): Promise<void> {
  const b = await env.DB.prepare("SELECT cote, joues FROM comptes WHERE id = ?").bind(p.bleu).first<{ cote: number; joues: number }>();
  const r = await env.DB.prepare("SELECT cote, joues FROM comptes WHERE id = ?").bind(p.rouge).first<{ cote: number; joues: number }>();
  const sb: 0 | 0.5 | 1 = issue === "blue" ? 1 : issue === "draw" ? 0.5 : 0;
  const db = b && r ? variation(b.cote, r.cote, sb, b.joues) : 0;
  const dr = b && r ? variation(r.cote, b.cote, (1 - sb) as 0 | 0.5 | 1, r.joues) : 0;
  const res = await env.DB.prepare("UPDATE parties SET issue = ?, fin = ?, delta_bleu = ?, delta_rouge = ? WHERE id = ? AND issue IS NULL").bind(issue, now, db, dr, p.id).run();
  if (!res.meta.changes) return; // (déjà soldée par l'autre camp)
  await env.DB.batch([
    env.DB.prepare("UPDATE comptes SET cote = cote + ?, joues = joues + 1, gagnes = gagnes + ? WHERE id = ?").bind(db, issue === "blue" ? 1 : 0, p.bleu),
    env.DB.prepare("UPDATE comptes SET cote = cote + ?, joues = joues + 1, gagnes = gagnes + ? WHERE id = ?").bind(dr, issue === "red" ? 1 : 0, p.rouge)
  ]);
}

/** Les parties d'un joueur restées sans l'autre rapport trop longtemps : soldées sur le seul rapport reçu. */
async function solderLesSilencieuses(env: Env, compte: string, now: number): Promise<void> {
  const { results } = await env.DB.prepare(
    "SELECT id, bleu, rouge, rapport_bleu, rapport_rouge FROM parties WHERE (bleu = ? OR rouge = ?) AND issue IS NULL AND debut < ? AND (rapport_bleu IS NOT NULL OR rapport_rouge IS NOT NULL)"
  ).bind(compte, compte, now - SILENCE_MS).all<{ id: string; bleu: string; rouge: string; rapport_bleu: Issue | null; rapport_rouge: Issue | null }>();
  for (const p of results) {
    const issue = depouiller({ bleu: p.rapport_bleu, rouge: p.rapport_rouge }, true);
    if (issue) await solder(env, p, issue, now);
  }
}

/**
 * Le classement :
 *   GET  /classement            {"tete":[{"nom","cote","joues","gagnes"}…50],"moi":{…,"rang"}|null}
 *   POST /classement/resultat   {"partie","issue":"blue"|"red"|"draw"} → {"issue","delta","cote"} (issue null : en
 *                               attente du rapport de l'autre)
 */
async function classement(req: Request, url: URL, env: Env): Promise<Response> {
  const origine = req.headers.get("Origin");
  if (origine !== null && !origineAdmise(origine)) return new Response("origine refusée", { status: 403 });
  const cors = enTetesCors(origine);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const now = Date.now();
  const auth = lireAuth(req.headers.get("Authorization"));
  if (url.pathname === "/classement" && req.method === "GET") {
    const c = await compteDe(env, auth);
    if (c) await solderLesSilencieuses(env, c.id, now);
    const { results } = await env.DB.prepare("SELECT id, cote, joues, gagnes FROM comptes WHERE joues > 0 ORDER BY cote DESC, joues DESC LIMIT 50").all<{
      id: string; cote: number; joues: number; gagnes: number;
    }>();
    const tete = results.map((r) => ({ nom: nomDe(r.id), cote: r.cote, joues: r.joues, gagnes: r.gagnes, moi: r.id === c?.id }));
    let moi = null;
    if (c) {
      const m = await env.DB.prepare("SELECT cote, joues, gagnes FROM comptes WHERE id = ?").bind(c.id).first<{ cote: number; joues: number; gagnes: number }>();
      const rang = m && m.joues > 0 ? ((await env.DB.prepare("SELECT count(*) AS n FROM comptes WHERE joues > 0 AND cote > ?").bind(m.cote).first<{ n: number }>())?.n ?? 0) + 1 : null;
      moi = { nom: nomDe(c.id), cote: m?.cote ?? c.cote, joues: m?.joues ?? 0, gagnes: m?.gagnes ?? 0, rang };
    }
    return json({ tete, moi }, 200, cors);
  }
  if (url.pathname === "/classement/resultat" && req.method === "POST") {
    const c = await compteDe(env, auth);
    if (!c) return json({ erreur: "compte inconnu" }, 401, cors);
    let corps: { partie?: unknown; issue?: unknown };
    try {
      corps = (await req.json()) as { partie?: unknown; issue?: unknown };
    } catch {
      return json({ erreur: "JSON attendu" }, 400, cors);
    }
    if (typeof corps.partie !== "string" || !issueAdmise(corps.issue)) return json({ erreur: "partie et issue attendues" }, 400, cors);
    const p = await env.DB.prepare("SELECT id, bleu, rouge, rapport_bleu, rapport_rouge, issue FROM parties WHERE id = ?").bind(corps.partie).first<{
      id: string; bleu: string; rouge: string; rapport_bleu: Issue | null; rapport_rouge: Issue | null; issue: Issue | null;
    }>();
    if (!p || (p.bleu !== c.id && p.rouge !== c.id)) return json({ erreur: "partie inconnue" }, 404, cors);
    const camp = p.bleu === c.id ? "bleu" : "rouge";
    if (!p.issue) {
      await env.DB.prepare(`UPDATE parties SET rapport_${camp} = ? WHERE id = ? AND rapport_${camp} IS NULL`).bind(corps.issue, p.id).run();
      const r = { bleu: camp === "bleu" ? corps.issue : p.rapport_bleu, rouge: camp === "rouge" ? corps.issue : p.rapport_rouge };
      const issue = depouiller(r, false);
      if (issue) await solder(env, p, issue, now);
    }
    const fin = await env.DB.prepare("SELECT issue, delta_bleu, delta_rouge FROM parties WHERE id = ?").bind(p.id).first<{ issue: Issue | null; delta_bleu: number; delta_rouge: number }>();
    const cote = (await env.DB.prepare("SELECT cote FROM comptes WHERE id = ?").bind(c.id).first<{ cote: number }>())?.cote ?? c.cote;
    return json({ issue: fin?.issue ?? null, delta: fin?.issue ? (camp === "bleu" ? fin.delta_bleu : fin.delta_rouge) : null, cote }, 200, cors);
  }
  return json({ erreur: "introuvable" }, 404, cors);
}

/** Les requêtes qui effacent un compte : sa sauvegarde, ses jetons, lui. */
function effacer(env: Env, id: string): D1PreparedStatement[] {
  return [
    env.DB.prepare("DELETE FROM sauvegardes WHERE compte = ?").bind(id),
    env.DB.prepare("DELETE FROM jetons WHERE compte = ?").bind(id),
    env.DB.prepare("DELETE FROM comptes WHERE id = ?").bind(id)
  ];
}

/** Une réponse JSON du service des comptes. */
function json(corps: unknown, statut: number, cors: Record<string, string>): Response {
  return new Response(corps === null ? null : JSON.stringify(corps), {
    status: statut,
    headers: { ...cors, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}

/**
 * Les comptes (comptes.ts) :
 *   POST   /compte              un compte neuf : {"id","jeton"}
 *   GET    /compte/sauvegarde   {"rev","donnees"} (rev 0 et donnees null : rien encore)
 *   PUT    /compte/sauvegarde   {"rev": la révision fusionnée, "donnees"} → {"rev"} ; 409 {"rev","donnees"} si un autre
 *                               appareil a envoyé entre-temps (le jeu fusionne et renvoie)
 *   POST   /compte/apple        {"jeton": le jeton d'Apple} → {"id","jeton","apple"} : le compte rattaché à Apple, ou celui
 *                               qui l'était déjà (jeton neuf pour cet appareil ; celui d'ici est effacé)
 *   DELETE /compte              le compte, ses jetons et sa sauvegarde effacés, pour de bon
 */
async function comptes(req: Request, url: URL, env: Env): Promise<Response> {
  const origine = req.headers.get("Origin");
  if (origine !== null && !origineAdmise(origine)) return new Response("origine refusée", { status: 403 });
  const cors = enTetesCors(origine);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const now = Date.now();
  if (url.pathname === "/compte" && req.method === "POST") {
    const ip = req.headers.get("CF-Connecting-IP") ?? "?";
    if (!(await env.CREATION.limit({ key: ip })).success) return json({ erreur: "trop de comptes" }, 429, cors);
    const id = crypto.randomUUID();
    const jeton = nouveauJeton();
    const e = await empreinte(jeton);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO comptes (id, empreinte, cree, vu) VALUES (?, ?, ?, ?)").bind(id, e, now, now),
      env.DB.prepare("INSERT INTO jetons (empreinte, compte, cree) VALUES (?, ?, ?)").bind(e, id, now)
    ]);
    return json({ id, jeton }, 201, cors);
  }
  const auth = lireAuth(req.headers.get("Authorization"));
  // (un compte a un jeton par appareil : celui-ci doit être un des siens)
  const compte = auth
    ? await env.DB.prepare("SELECT c.vu, c.apple FROM jetons j JOIN comptes c ON c.id = j.compte WHERE j.empreinte = ? AND j.compte = ?")
        .bind(await empreinte(auth.jeton), auth.id)
        .first<{ vu: number; apple: string | null }>()
    : null;
  if (!auth || !compte) return json({ erreur: "compte inconnu" }, 401, cors);
  // (vu : une écriture par heure au plus)
  if (now - compte.vu > 3_600_000) await env.DB.prepare("UPDATE comptes SET vu = ? WHERE id = ?").bind(now, auth.id).run();
  if (url.pathname === "/compte" && req.method === "DELETE") {
    await env.DB.batch(effacer(env, auth.id));
    return json(null, 204, cors);
  }
  if (url.pathname === "/compte/apple" && req.method === "POST") {
    // « Se connecter avec Apple » : le compte prend l'identifiant Apple du joueur ; s'il est déjà celui d'un autre
    // compte (le joueur s'est connecté sur un autre appareil), c'est celui-là qui est rendu, avec un jeton neuf pour cet
    // appareil, et le compte d'ici (anonyme) est effacé : le jeu fusionne sa progression dans l'autre à la synchro.
    let corps: { jeton?: unknown };
    try {
      corps = (await req.json()) as { jeton?: unknown };
    } catch {
      return json({ erreur: "JSON attendu" }, 400, cors);
    }
    const cles = await fetch(APPLE_CLES, { headers: { "user-agent": "panache-relais (+https://menufactory43.github.io/panache/)", accept: "application/json" }, cf: { cacheTtl: 3600, cacheEverything: true } } as RequestInit)
      .then((r) => (r.ok ? (r.json() as Promise<{ keys: CleApple[] }>) : null))
      .catch(() => null);
    if (!cles) return json({ erreur: "Apple injoignable" }, 503, cors);
    const v = await verifierJetonApple(String(corps.jeton ?? ""), cles.keys, auth.id, now);
    if (!v.ok) return json({ erreur: `jeton Apple refusé : ${v.raison}` }, 401, cors);
    const deja = await env.DB.prepare("SELECT id FROM comptes WHERE apple = ?").bind(v.sub).first<{ id: string }>();
    if (!deja || deja.id === auth.id) {
      await env.DB.prepare("UPDATE comptes SET apple = ? WHERE id = ?").bind(v.sub, auth.id).run();
      return json({ id: auth.id, jeton: null, apple: true }, 200, cors);
    }
    const jeton = nouveauJeton();
    await env.DB.batch([env.DB.prepare("INSERT INTO jetons (empreinte, compte, cree) VALUES (?, ?, ?)").bind(await empreinte(jeton), deja.id, now), ...effacer(env, auth.id)]);
    return json({ id: deja.id, jeton, apple: true }, 200, cors);
  }
  if (url.pathname !== "/compte/sauvegarde") return json({ erreur: "introuvable" }, 404, cors);
  const actuelle = () => env.DB.prepare("SELECT rev, donnees FROM sauvegardes WHERE compte = ?").bind(auth.id).first<{ rev: number; donnees: string }>();
  const telle = (s: { rev: number; donnees: string } | null) => ({ rev: s?.rev ?? 0, donnees: s ? JSON.parse(s.donnees) : null, apple: !!compte.apple });
  if (req.method === "GET") return json(telle(await actuelle()), 200, cors);
  if (req.method !== "PUT") return json({ erreur: "méthode" }, 405, cors);
  const envoi = lireEnvoi(await req.text());
  if (!envoi.ok) return json({ erreur: envoi.raison }, envoi.statut, cors);
  // la révision n'avance que depuis celle que le jeu a lue : sinon, un autre appareil est passé entre-temps
  const r =
    envoi.base === 0
      ? await env.DB.prepare("INSERT INTO sauvegardes (compte, rev, donnees, maj) VALUES (?, 1, ?, ?) ON CONFLICT (compte) DO NOTHING").bind(auth.id, envoi.donnees, now).run()
      : await env.DB.prepare("UPDATE sauvegardes SET rev = rev + 1, donnees = ?, maj = ? WHERE compte = ? AND rev = ?").bind(envoi.donnees, now, auth.id, envoi.base).run();
  if (!r.meta.changes) return json(telle(await actuelle()), 409, cors);
  return json({ rev: envoi.base + 1 }, 200, cors);
}

/** Un envoi ne doit jamais faire échouer celui qui l'appelle : l'autre peut partir à tout moment. */
function envoyer(ws: WebSocket, msg: string): void {
  try {
    ws.send(msg);
  } catch {
    // parti
  }
}

function fermer(ws: WebSocket, code: number, raison: string): void {
  try {
    ws.close(code, raison);
  } catch {
    // déjà fermé
  }
}

export class Salon extends DurableObject<Env> {
  /** Le débit de chaque connexion (en mémoire : il repart à neuf après une hibernation, ce qui est sans gravité). */
  private seaux = new Map<WebSocket, Seau>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // le « ping » du jeu (toutes les 2 s) : répondu sans réveiller le salon
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  private async etat(): Promise<Etat> {
    return (await this.ctx.storage.get<Etat>("etat")) ?? VIDE;
  }

  /** Les connexions ouvertes d'un rôle (getWebSockets garde aussi celles qui se ferment). */
  private ouverts(role: Role): WebSocket[] {
    return this.ctx.getWebSockets(role).filter((w) => w.readyState === WebSocket.OPEN);
  }

  private branches(sauf?: WebSocket): Set<Role> {
    const s = new Set<Role>();
    for (const r of ["hote", "invite"] as const) if (this.ouverts(r).some((w) => w !== sauf)) s.add(r);
    return s;
  }

  private roleOf(ws: WebSocket): Role {
    return this.ctx.getTags(ws).includes("hote") ? "hote" : "invite";
  }

  private async reveil(e: Etat, branches: Set<Role>): Promise<void> {
    const t = prochainReveil(e, branches);
    if (t === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(t + 1000);
  }

  async fetch(req: Request): Promise<Response> {
    const q = new URL(req.url).searchParams;
    const role: Role = q.get("role") === "hote" ? "hote" : "invite";
    const cle = (q.get("cle") ?? "").slice(0, CLE_MAX);
    const nouveau = q.get("nouveau") === "1";
    const now = Date.now();
    const e = await this.etat();
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    const ok = admettre(e, role, cle, nouveau, this.branches(), now);
    if (!ok.ok) {
      // (refusé, mais par la WebSocket : un navigateur ne lit pas le statut d'une poignée de main ratée, il lit le code de fermeture)
      server.accept();
      fermer(server, ok.code, ok.raison);
      return new Response(null, { status: 101, webSocket: client });
    }
    const next = entrer(e, role, cle, nouveau, now);
    await this.ctx.storage.put("etat", next);
    // une seule connexion par place : la nouvelle remplace l'ancienne (une reconnexion avant que l'ancienne soit vue morte)
    for (const old of this.ctx.getWebSockets(role)) fermer(old, FERME.remplace, "remplacé");
    this.ctx.acceptWebSocket(server, [role]);
    const other = this.ouverts(autre(role));
    envoyer(server, JSON.stringify({ t: "salut", role, pair: other.length > 0 }));
    for (const o of other) envoyer(o, JSON.stringify({ t: "pair", on: true }));
    await this.reveil(next, new Set([...this.branches(), role]));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer): Promise<void> {
    if (!relayable(msg)) return;
    let seau = this.seaux.get(ws);
    if (!seau) this.seaux.set(ws, (seau = new Seau(Date.now())));
    if (!seau.prendre(Date.now())) {
      // (un jeu normal n'en arrive jamais là : 400 refus d'affilée, c'est autre chose)
      if (seau.refus > 400) fermer(ws, FERME.abus, "trop de messages");
      return;
    }
    for (const o of this.ouverts(autre(this.roleOf(ws)))) envoyer(o, msg);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    this.seaux.delete(ws);
    const role = this.roleOf(ws);
    // encore quelqu'un à cette place (il vient de se reconnecter) : rien à dire
    if (this.ouverts(role).some((w) => w !== ws)) return;
    const e = await this.etat();
    // (un refus n'a pas de place : rien à garder pour lui)
    if (!e[role]) return;
    const next = sortir(e, role, Date.now());
    await this.ctx.storage.put("etat", next);
    for (const o of this.ouverts(autre(role))) envoyer(o, JSON.stringify({ t: "pair", on: false }));
    await this.reveil(next, this.branches(ws));
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  /** Le ménage : un salon vide après sa fenêtre de reconnexion, ou trop vieux, est effacé. */
  async alarm(): Promise<void> {
    const e = await this.etat();
    const branches = this.branches();
    const now = Date.now();
    if (!perime(e, branches, now)) return void (await this.reveil(e, branches));
    for (const w of this.ctx.getWebSockets()) fermer(w, FERME.expire, "salon expiré");
    await this.ctx.storage.deleteAll();
  }
}

/** Les compteurs du jeu : un seul objet, une clé « jour|événement » par compteur, les plus vieux jours effacés. */
export class Stats extends DurableObject<Env> {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const now = Date.now();
    if (req.method === "POST") {
      const e = url.searchParams.get("e")!;
      const cle = cleDe(jourDe(now), e);
      await this.ctx.storage.put(cle, ((await this.ctx.storage.get<number>(cle)) ?? 0) + 1);
      if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(now + 86_400_000);
      return new Response(null, { status: 204 });
    }
    const jours = joursDepuis(now, Number(url.searchParams.get("jours") ?? 30));
    const lus = await this.ctx.storage.list<number>({ start: `${jours[0]}|`, end: `${jours[jours.length - 1]}|~` });
    return new Response(JSON.stringify(parJour(lus), null, 1), {
      headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "cache-control": "no-store" }
    });
  }

  /** Le ménage, une fois par jour tant qu'il y a des compteurs. */
  async alarm(): Promise<void> {
    const vieux = await this.ctx.storage.list({ end: `${limiteMenage(Date.now())}|` });
    if (vieux.size) await this.ctx.storage.delete([...vieux.keys()].slice(0, 128));
    await this.ctx.storage.setAlarm(Date.now() + 86_400_000);
  }
}

/** Ce que la file garde de chaque connexion (survit à l'hibernation). */
interface EnFile {
  compte: string;
  cote: number;
  build: number;
  depuis: number;
}

/** Les lettres des codes de salon (salon.ts ALPHABET, versus/online.ts CODE_ALPHABET). */
const LETTRES = "ABCDEFGHJKLMNPQRSTUVWXYZ";

/**
 * La file d'attente des parties classées (classement.ts) : un seul objet. Chaque joueur qui cherche y tient une
 * WebSocket ; toutes les 2 s (et à chaque arrivée) l'objet apparie ce qui peut l'être, inscrit la partie dans la base,
 * envoie à chacun son adversaire, le code du salon, son rôle (l'hôte joue bleu) et la carte, puis ferme. Un joueur
 * qui part (application en arrière-plan, Annuler) quitte la file en fermant sa connexion.
 */
export class FileAttente extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  private ouverts(): WebSocket[] {
    return this.ctx.getWebSockets().filter((w) => w.readyState === WebSocket.OPEN);
  }

  async fetch(req: Request): Promise<Response> {
    const compte = req.headers.get("x-compte")!;
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    // (le même compte déjà en file depuis un autre appareil, ou une connexion morte pas encore vue : la nouvelle remplace)
    for (const w of this.ouverts()) if ((w.deserializeAttachment() as EnFile | null)?.compte === compte) fermer(w, 4000, "remplacé");
    this.ctx.acceptWebSocket(server);
    const moi: EnFile = { compte, cote: Number(req.headers.get("x-cote")), build: Number(req.headers.get("x-build")), depuis: Date.now() };
    server.serializeAttachment(moi);
    envoyer(server, JSON.stringify({ t: "file", nom: nomDe(compte), cote: moi.cote, attente: this.ouverts().length - 1 }));
    await this.tenter();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(): Promise<void> {
    // (le jeu n'envoie que « ping », répondu sans réveil)
  }

  async alarm(): Promise<void> {
    await this.tenter();
  }

  private async tenter(): Promise<void> {
    const now = Date.now();
    const ws = this.ouverts();
    const par = new Map<string, WebSocket>();
    const file: Attente[] = ws.map((w, i) => {
      const a = w.deserializeAttachment() as EnFile;
      par.set(String(i), w);
      return { ws: String(i), compte: a.compte, cote: a.cote, build: a.build, depuis: a.depuis };
    });
    const pris = new Set<string>();
    for (const [a, b] of apparier(file, now)) {
      pris.add(a.ws).add(b.ws);
      const hote = Math.random() < 0.5 ? a : b;
      const invite = hote === a ? b : a;
      const code = Array.from(crypto.getRandomValues(new Uint8Array(4)), (x) => LETTRES[x % LETTRES.length]).join("");
      const carte = CARTES_CLASSEES[Math.floor(Math.random() * CARTES_CLASSEES.length)]!;
      const partie = crypto.randomUUID();
      await this.env.DB.prepare("INSERT INTO parties (id, code, carte, bleu, rouge, debut) VALUES (?, ?, ?, ?, ?, ?)").bind(partie, code, carte, hote.compte, invite.compte, now).run();
      const fiche = (x: Attente) => ({ nom: nomDe(x.compte), cote: x.cote });
      for (const [moi, lui, role] of [[hote, invite, "hote"], [invite, hote, "invite"]] as const) {
        const w = par.get(moi.ws)!;
        envoyer(w, JSON.stringify({ t: "adversaire", partie, code, role, carte, moi: fiche(moi), lui: fiche(lui) }));
        fermer(w, 1000, "adversaire trouvé");
      }
    }
    const restent = file.filter((x) => !pris.has(x.ws));
    for (const x of restent) envoyer(par.get(x.ws)!, JSON.stringify({ t: "file", attente: restent.length - 1, depuis: now - x.depuis }));
    if (restent.length) await this.ctx.storage.setAlarm(now + 2000);
  }
}
