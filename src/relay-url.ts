/**
 * Where the relay is (relay/README.md): the duel's lobby (versus/online.ts)
 * and the cloud save (game/account.ts) both call it.
 */

/** The relay the published game uses (relay/README.md). `?relais=` overrides it (a `wrangler dev` on localhost). */
export const RELAY_URL = "wss://panache-relais.meffysto.workers.dev";

/** The relay to use: `?relais=` (ws:// or wss://, or http(s):// read as such), else RELAY_URL. */
export function relayBase(search: string): string {
  const r = new URLSearchParams(search).get("relais")?.trim();
  if (r && /^(wss?|https?):\/\/[^\s]+$/i.test(r)) return r.replace(/^http/i, "ws").replace(/\/+$/, "");
  return RELAY_URL;
}
