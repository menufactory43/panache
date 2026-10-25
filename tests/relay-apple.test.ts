import { beforeAll, describe, expect, it } from "vitest";
import { APPLE_APP, APPLE_EMETTEUR, APPLE_JETON, APPLE_REVOQUER, revoquerApple, secretClient, verifierJetonApple, type CleApple } from "../relay/src/apple";

const b64url = (b: Uint8Array | string) =>
  Buffer.from(typeof b === "string" ? new TextEncoder().encode(b) : b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

let priv: CryptoKey;
let other: CryptoKey;
let cles: CleApple[];

async function signe(corps: Record<string, unknown>, key = priv, kid = "k1"): Promise<string> {
  const h = b64url(JSON.stringify({ alg: "RS256", kid }));
  const p = b64url(JSON.stringify(corps));
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${h}.${p}`)));
  return `${h}.${p}.${b64url(sig)}`;
}

const NOW = 1_800_000_000_000;
const COMPTE = "8f0e6c1a-2b3c-4d5e-8f70-1234567890ab";
const bon = (extra: Record<string, unknown> = {}) => ({ iss: APPLE_EMETTEUR, aud: APPLE_APP, exp: NOW / 1000 + 600, iat: NOW / 1000, sub: "001234.abcd", nonce: COMPTE, ...extra });

beforeAll(async () => {
  const gen = () => crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const a = await gen();
  const b = await gen();
  priv = a.privateKey;
  other = b.privateKey;
  const jwk = (await crypto.subtle.exportKey("jwk", a.publicKey)) as JsonWebKey;
  cles = [{ kid: "k1", kty: "RSA", alg: "RS256", n: jwk.n!, e: jwk.e! }];
});

describe("Sign in with Apple, on the relay", () => {
  it("takes a token Apple signed for this app and this account", async () => {
    expect(await verifierJetonApple(await signe(bon()), cles, COMPTE, NOW)).toEqual({ ok: true, sub: "001234.abcd" });
    expect(await verifierJetonApple(await signe(bon({ aud: [APPLE_APP, "x"] })), cles, COMPTE, NOW)).toMatchObject({ ok: true });
  });

  it("turns down everything else", async () => {
    const non = async (jwt: string, raison: string) => expect(await verifierJetonApple(jwt, cles, COMPTE, NOW)).toEqual({ ok: false, raison });
    await non("abc", "jeton illisible");
    await non(await signe(bon(), other), "signature");
    await non(await signe(bon(), priv, "k2"), "clé inconnue");
    await non(await signe(bon({ iss: "https://evil.example" })), "émetteur");
    await non(await signe(bon({ aud: "com.other.app" })), "destinataire");
    await non(await signe(bon({ exp: NOW / 1000 - 1 })), "expiré");
    await non(await signe(bon({ iat: NOW / 1000 + 3600 })), "du futur");
    await non(await signe(bon({ nonce: "another-account" })), "pour un autre compte");
    await non(await signe(bon({ sub: "" })), "sans sub");
    // a tampered body under a good signature
    const [h, , s] = (await signe(bon())).split(".");
    await non(`${h}.${b64url(JSON.stringify(bon({ sub: "someone-else" })))}.${s}`, "signature");
  });
});

describe("revoking a deleted account's Apple link", () => {
  let pem = "";
  let pub: CryptoKey;
  beforeAll(async () => {
    const k = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", k.privateKey));
    pem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(der).toString("base64").replace(/(.{64})/g, "$1\n")}\n-----END PRIVATE KEY-----\n`;
    pub = k.publicKey;
  });
  const unb64 = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

  it("signs the client secret Apple asks for with the team's key", async () => {
    const now = Date.UTC(2026, 9, 25);
    const jwt = await secretClient(pem, "KID1234567", now);
    const [h, p, s] = jwt.split(".") as [string, string, string];
    expect(JSON.parse(unb64(h).toString())).toEqual({ alg: "ES256", kid: "KID1234567" });
    expect(JSON.parse(unb64(p).toString())).toMatchObject({ iss: "AKMNXGVVGX", sub: APPLE_APP, aud: APPLE_EMETTEUR, iat: now / 1000, exp: now / 1000 + 300 });
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, unb64(s), new TextEncoder().encode(`${h}.${p}`))).toBe(true);
  });

  /** Apple, faked: the exchange gives `sub`'s tokens, the revocation answers `revoque`. */
  const apple = (sub: string, revoque = 200) => {
    const calls: { url: string; body: URLSearchParams }[] = [];
    const get = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: new URLSearchParams(String(init.body)) });
      if (url === APPLE_JETON) return new Response(JSON.stringify({ refresh_token: "r.1", access_token: "a.1", id_token: `x.${b64url(JSON.stringify({ sub }))}.y` }));
      return new Response(null, { status: revoque });
    }) as unknown as typeof fetch;
    return { get, calls };
  };

  it("exchanges the fresh code, then revokes the refresh token", async () => {
    const a = apple("player-1");
    expect(await revoquerApple("code-1", "player-1", { pem, kid: "K" }, Date.now(), a.get)).toEqual({ ok: true });
    expect(a.calls.map((c) => c.url)).toEqual([APPLE_JETON, APPLE_REVOQUER]);
    expect(a.calls[0]!.body.get("code")).toBe("code-1");
    expect(a.calls[1]!.body.get("token")).toBe("r.1");
    expect(a.calls[1]!.body.get("token_type_hint")).toBe("refresh_token");
  });

  it("revokes nothing for another player's code, and says when Apple refuses", async () => {
    const other = apple("someone-else");
    expect(await revoquerApple("code-1", "player-1", { pem, kid: "K" }, Date.now(), other.get)).toEqual({ ok: false, raison: "code d'un autre joueur" });
    expect(other.calls).toHaveLength(1);
    expect((await revoquerApple("code-1", "player-1", { pem, kid: "K" }, Date.now(), apple("player-1", 400).get)).ok).toBe(false);
  });
});
