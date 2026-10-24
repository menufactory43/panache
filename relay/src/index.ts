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
import { empreinte, enTetesCors, lireAuth, lireEnvoi, nouveauJeton } from "./comptes";
import { cleDe, evenementAdmis, jourDe, joursDepuis, limiteMenage, parJour } from "./stats";

interface Env {
  SALON: DurableObjectNamespace<Salon>;
  STATS: DurableObjectNamespace<Stats>;
  /** Les comptes et leurs sauvegardes (migrations/). */
  DB: D1Database;
  /** Au plus quelques comptes créés par minute et par adresse. */
  CREATION: RateLimit;
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
    const code = codeDe(url.pathname);
    if (!code) return new Response("introuvable", { status: 404 });
    if (!origineAdmise(req.headers.get("Origin"))) return new Response("origine refusée", { status: 403 });
    if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("websocket attendu", { status: 426 });
    const stub = env.SALON.get(env.SALON.idFromName(code));
    return stub.fetch(req);
  }
};

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
