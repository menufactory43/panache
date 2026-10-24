/**
 * Ranked duels (relay/README.md « Classement »): the queue, the result, the
 * ladder. The relay's queue pairs two players of close ratings who run the
 * same duel code and sends each the room code, their role (the host plays
 * blue) and a map drawn for the match; the duel then runs as any online duel,
 * on that map with no mutators. At the end each side reports what it saw; the
 * relay settles the ratings when the reports agree (a loss counts at once).
 *
 * Ranked play needs an account (account.ts): off with the cloud save off.
 */
import { accountForRanked } from "./account";
import { tr } from "../lang";

export interface RankedCard {
  nom: string;
  cote: number;
}

export interface RankedMatch {
  partie: string;
  code: string;
  role: "hote" | "invite";
  carte: string;
  moi: RankedCard;
  lui: RankedCard;
}

export interface QueueHandlers {
  /** In the queue: who this player is there, how many others wait, since when (ms). */
  onWait(w: { nom?: string; cote?: number; attente: number; depuis: number }): void;
  onMatch(m: RankedMatch): void;
  /** The queue can't be had: no account, no network, or the relay turned this page down. */
  onError(why: "account" | "offline" | "version"): void;
}

/** The match being played ranked (set from the lobby, read at its end), or null. */
let current: (RankedMatch & { side: "blue" | "red" }) | null = null;
export const rankedMatch = () => current;
export function setRankedMatch(m: RankedMatch | null): void {
  current = m ? { ...m, side: m.role === "hote" ? "blue" : "red" } : null;
}

/** Join the queue; returns the way out (Cancel, the sheet closed, the app sent to the background). */
export function joinQueue(build: number, h: QueueHandlers): () => void {
  let ws: WebSocket | null = null;
  let ping = 0;
  let done = false;
  const since = Date.now();
  const stop = () => {
    done = true;
    clearInterval(ping);
    try {
      ws?.close(1000);
    } catch {
      /* closed */
    }
  };
  void (async () => {
    const acc = await accountForRanked();
    if (done) return;
    if (!acc) return h.onError("account");
    const url = `${acc.root.replace(/^http/i, "ws")}/file?id=${encodeURIComponent(acc.id)}&jeton=${encodeURIComponent(acc.jeton)}&build=${build}`;
    ws = new WebSocket(url);
    ping = window.setInterval(() => ws?.readyState === WebSocket.OPEN && ws.send("ping"), 20_000);
    let matched = false;
    ws.onmessage = (e) => {
      if (typeof e.data !== "string" || e.data === "pong") return;
      let m: { t?: string } & Record<string, unknown>;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m.t === "file") h.onWait({ nom: m.nom as string | undefined, cote: m.cote as number | undefined, attente: Number(m.attente) || 0, depuis: Date.now() - since });
      else if (m.t === "adversaire") {
        matched = true;
        done = true;
        clearInterval(ping);
        h.onMatch(m as unknown as RankedMatch);
      }
    };
    ws.onclose = (e) => {
      clearInterval(ping);
      if (done || matched) return;
      done = true;
      h.onError(e.code === 4001 ? (e.reason === "version" ? "version" : "account") : "offline");
    };
  })();
  return stop;
}

export interface RankedOutcome {
  /** The settled result (null: the other side's report is awaited). */
  issue: "blue" | "red" | "draw" | null;
  /** This player's rating change, once settled. */
  delta: number | null;
  cote: number;
}

/** Report how the ranked match ended (what this page saw). Tries a few times; null if the relay can't be reached. */
export async function reportRanked(m: RankedMatch, issue: "blue" | "red" | "draw"): Promise<RankedOutcome | null> {
  const acc = await accountForRanked();
  if (!acc) return null;
  for (let i = 0; i < 4; i++) {
    try {
      const res = await fetch(`${acc.root}/classement/resultat`, {
        method: "POST",
        headers: { authorization: `Bearer ${acc.id}.${acc.jeton}`, "content-type": "application/json" },
        body: JSON.stringify({ partie: m.partie, issue }),
        keepalive: true
      });
      if (res.ok) return (await res.json()) as RankedOutcome;
      if (res.status < 500) return null;
    } catch {
      /* the network: again */
    }
    await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
  }
  return null;
}

/**
 * The ranked match is over here (GameScene): `winner` as this page saw it, null with no result (a desync). Reports
 * it once and says the new rating; the rematch that may follow is a friendly duel.
 */
export function endRanked(winner: "blue" | "red" | "draw" | null, say: (msg: string, tone?: "good" | "bad") => void): void {
  const m = current;
  current = null;
  if (!m || !winner) return;
  void reportRanked(m, winner).then((r) => {
    if (!r) return say(tr("Classement : le résultat n'a pas pu être envoyé", "Ranked: the result couldn't be sent"), "bad");
    if (r.delta === null) return say(tr("Classement : en attente du rapport de l'adversaire", "Ranked: waiting for the opponent's report"));
    const d = `${r.delta >= 0 ? "+" : "−"}${Math.abs(r.delta)}`;
    say(tr(`Cote ${m.moi.cote} → ${r.cote} (${d})`, `Rating ${m.moi.cote} → ${r.cote} (${d})`), r.delta >= 0 ? "good" : "bad");
  });
}

export interface LadderRow {
  nom: string;
  cote: number;
  joues: number;
  gagnes: number;
  moi?: boolean;
}

export interface Ladder {
  tete: LadderRow[];
  moi: (LadderRow & { rang: number | null }) | null;
}

/** The ladder's top 50 and this player's place; null without an account or network. */
export async function fetchLadder(): Promise<Ladder | null> {
  const acc = await accountForRanked();
  if (!acc) return null;
  try {
    const res = await fetch(`${acc.root}/classement`, { headers: { authorization: `Bearer ${acc.id}.${acc.jeton}` }, cache: "no-store" });
    return res.ok ? ((await res.json()) as Ladder) : null;
  } catch {
    return null;
  }
}
