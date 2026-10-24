import { describe, expect, it } from "vitest";
import { SAUVEGARDE_MAX, empreinte, enTetesCors, lireAuth, lireEnvoi, memeEmpreinte, nouveauJeton } from "../relay/src/comptes";

describe("the relay's accounts", () => {
  it("draws tokens that can't be guessed, and keeps only their fingerprint", async () => {
    const a = nouveauJeton();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(nouveauJeton()).not.toBe(a);
    const e = await empreinte(a);
    expect(e).toMatch(/^[0-9a-f]{64}$/);
    expect(e).not.toContain(a);
    expect(memeEmpreinte(e, await empreinte(a))).toBe(true);
    expect(memeEmpreinte(e, await empreinte(nouveauJeton()))).toBe(false);
    expect(memeEmpreinte(e, e.slice(1))).toBe(false);
  });

  it("reads « Bearer <id>.<token> » and nothing else", () => {
    const id = crypto.randomUUID();
    const jeton = nouveauJeton();
    expect(lireAuth(`Bearer ${id}.${jeton}`)).toEqual({ id, jeton });
    for (const h of [null, "", `${id}.${jeton}`, `Bearer ${id}`, `Bearer nope.${jeton}`, `Bearer ${id}.court`, `Basic ${id}.${jeton}`])
      expect(lireAuth(h), String(h)).toBeNull();
  });

  it("answers CORS for the game's own pages only", () => {
    for (const o of ["https://menufactory43.github.io", "capacitor://localhost", "http://localhost:5173"])
      expect(enTetesCors(o)["access-control-allow-origin"], o).toBe(o);
    expect(enTetesCors("https://evil.example")).toEqual({});
    expect(enTetesCors(null)).toEqual({});
  });

  it("checks a save before it is stored", () => {
    expect(lireEnvoi(JSON.stringify({ rev: 3, donnees: { v: 1 } }))).toEqual({ ok: true, base: 3, donnees: '{"v":1}' });
    expect(lireEnvoi("pas du json")).toMatchObject({ ok: false, statut: 400 });
    expect(lireEnvoi(JSON.stringify({ donnees: {} }))).toMatchObject({ ok: false, statut: 400 });
    expect(lireEnvoi(JSON.stringify({ rev: -1, donnees: {} }))).toMatchObject({ ok: false, statut: 400 });
    expect(lireEnvoi(JSON.stringify({ rev: 1.5, donnees: {} }))).toMatchObject({ ok: false, statut: 400 });
    expect(lireEnvoi(JSON.stringify({ rev: 0, donnees: [1] }))).toMatchObject({ ok: false, statut: 400 });
    expect(lireEnvoi(JSON.stringify({ rev: 0, donnees: { x: "a".repeat(SAUVEGARDE_MAX) } }))).toMatchObject({ ok: false, statut: 413 });
  });
});
