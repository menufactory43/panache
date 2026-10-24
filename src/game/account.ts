/**
 * The player's account and cloud save (relay/README.md « Comptes »). An
 * account is made on the first launch without asking anything: an id and a
 * token from the relay, kept on the device (in the iPhone app, in its
 * preferences, which outlive the web view's storage). The save (save.ts) is
 * merged with the cloud's copy at launch, after every match and when the app
 * leaves the screen, so progress survives a wiped web view and, once accounts
 * can be signed into, follows the player to another device.
 *
 * Off in development and for robots (the smoke test): no accounts made there.
 * The player can turn the cloud save off in Réglages, which deletes the
 * account and its save for good; progress on the device stays.
 */
import { Preferences } from "@capacitor/preferences";
import { AppleSignIn } from "panache-apple-sign-in";
import { RELAY_URL, relayBase } from "../relay-url";
import { isApp } from "../native";
import { mergeSaves, readSave, sanitizeSave, saveText, writeSave } from "./save";

const CREDS_KEY = "panache.compte";
/** Set when the player turned the cloud save off: no account is made again until they turn it on. */
const OFF_KEY = "panache.compte.coupe";

interface Creds {
  id: string;
  jeton: string;
}

export type AccountState = "off" | "pending" | "ok" | "offline";

export interface AccountStatus {
  state: AccountState;
  /** When the save was last in step with the cloud (ms), or null. */
  at: number | null;
  /** Signed in with Apple: the same account on every device the player signs in on. */
  apple: boolean;
}

let status: AccountStatus = { state: "pending", at: null, apple: false };
const listeners = new Set<(s: AccountStatus) => void>();
let onProgress: () => void = () => undefined;

function setStatus(s: AccountStatus): void {
  status = s;
  for (const fn of listeners) fn(s);
}

/** The account's state now, and a way to follow it (returns the unsubscribe). */
export function accountStatus(): AccountStatus {
  return status;
}
export function watchAccount(fn: (s: AccountStatus) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The relay's HTTP address: the duel's, or `?relais=` (a `wrangler dev`). */
function base(): string | null {
  const ws = relayBase(location.search);
  // (development and robots: only against a relay asked for by name, never the published one)
  if ((import.meta.env.DEV || navigator.webdriver === true) && ws === RELAY_URL) return null;
  return ws.replace(/^ws/i, "http");
}

async function getPref(k: string): Promise<string | null> {
  if (isApp) return (await Preferences.get({ key: k })).value;
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
async function setPref(k: string, v: string | null): Promise<void> {
  if (isApp) return v === null ? Preferences.remove({ key: k }) : Preferences.set({ key: k, value: v });
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {
    /* storage blocked: no account */
  }
}

async function loadCreds(): Promise<Creds | null> {
  try {
    const c = JSON.parse((await getPref(CREDS_KEY)) ?? "null") as Partial<Creds> | null;
    return c && typeof c.id === "string" && typeof c.jeton === "string" ? { id: c.id, jeton: c.jeton } : null;
  } catch {
    return null;
  }
}

async function call(url: string, init: RequestInit, creds?: Creds): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (creds) headers.authorization = `Bearer ${creds.id}.${creds.jeton}`;
  return fetch(url, { ...init, headers, cache: "no-store" });
}

async function ensureCreds(root: string): Promise<Creds | null> {
  const have = await loadCreds();
  if (have) return have;
  const res = await call(`${root}/compte`, { method: "POST" });
  if (!res.ok) return null;
  const c = (await res.json()) as Creds;
  await setPref(CREDS_KEY, JSON.stringify({ id: c.id, jeton: c.jeton }));
  return c;
}

const store = {
  getItem: (k: string) => localStorage.getItem(k),
  setItem: (k: string, v: string) => localStorage.setItem(k, v)
};

let running: Promise<void> | null = null;
let again = false;

/** Merge this device's save with the cloud's, both ways. Never throws; the status says how it went. */
export function syncSave(): Promise<void> {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    do {
      again = false;
      await syncOnce();
    } while (again);
  })().finally(() => (running = null));
  return running;
}

async function syncOnce(): Promise<void> {
  const root = base();
  if (!root || (await getPref(OFF_KEY)) === "1") return setStatus({ state: "off", at: null, apple: false });
  try {
    let creds = await ensureCreds(root);
    if (!creds) return setStatus({ ...status, state: "offline" });
    let res = await call(`${root}/compte/sauvegarde`, { method: "GET" }, creds);
    if (res.status === 401) {
      // (the account is gone: a new one, and this device's progress goes up into it)
      await setPref(CREDS_KEY, null);
      creds = await ensureCreds(root);
      if (!creds) return setStatus({ ...status, state: "offline" });
      res = await call(`${root}/compte/sauvegarde`, { method: "GET" }, creds);
    }
    if (!res.ok) return setStatus({ ...status, state: "offline" });
    let remote = (await res.json()) as { rev: number; donnees: unknown; apple?: boolean };
    const apple = !!remote.apple;
    for (let tries = 0; tries < 4; tries++) {
      const theirs = remote.donnees ? sanitizeSave(remote.donnees) : null;
      const merged = theirs ? mergeSaves(readSave(store), theirs) : readSave(store);
      if (writeSave(store, merged)) onProgress();
      if (theirs && saveText(theirs) === saveText(merged)) return setStatus({ state: "ok", at: Date.now(), apple });
      const put = await call(`${root}/compte/sauvegarde`, { method: "PUT", body: JSON.stringify({ rev: remote.rev, donnees: merged }), keepalive: true }, creds);
      if (put.ok) return setStatus({ state: "ok", at: Date.now(), apple });
      if (put.status !== 409) return setStatus({ ...status, state: "offline" });
      // another device sent in between: merge with theirs and try again
      remote = (await put.json()) as { rev: number; donnees: unknown; apple?: boolean };
    }
    setStatus({ ...status, state: "offline" });
  } catch {
    setStatus({ ...status, state: "offline" }); // (no network: the next sync catches up)
  }
}

let timer: ReturnType<typeof setTimeout> | undefined;
/** Sync soon (a match just ended: the career and records are written in the same moment). */
export function scheduleSync(ms = 2500): void {
  clearTimeout(timer);
  if (typeof document === "undefined") return; // (under Node: the tests settle matches too)
  timer = setTimeout(() => void syncSave(), ms);
}

/**
 * Start the cloud save: a sync now, then whenever the app leaves the screen.
 * `progressChanged` runs when the cloud brought progress this device didn't
 * have (the hub redraws its rank, medals and missions).
 */
export function startAccount(progressChanged: () => void): void {
  onProgress = progressChanged;
  scheduleSync(1500);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void syncSave();
  });
}

/** « Se connecter avec Apple » is offered: in the iPhone app, with the cloud save on. */
export const appleOffered = (): boolean => isApp;

export type AppleResult = "ok" | "canceled" | "failed";

/**
 * « Se connecter avec Apple »: Apple's sheet, then the relay ties this
 * account to the player's Apple id, or hands back the account that already
 * has it (signed in on another device), whose save this device's progress is
 * then merged into.
 */
export async function signInWithApple(): Promise<AppleResult> {
  const root = base();
  if (!root || !isApp) return "failed";
  try {
    await setPref(OFF_KEY, null);
    const creds = await ensureCreds(root);
    if (!creds) return "failed";
    let token: string;
    try {
      // (the account's id as the nonce: the token is good for this account only, relay/src/apple.ts)
      token = (await AppleSignIn.authorize({ nonce: creds.id })).identityToken;
    } catch (e) {
      return (e as { code?: string })?.code === "CANCELED" ? "canceled" : "failed";
    }
    const res = await call(`${root}/compte/apple`, { method: "POST", body: JSON.stringify({ jeton: token }) }, creds);
    if (!res.ok) return "failed";
    const r = (await res.json()) as { id: string; jeton: string | null };
    if (r.jeton) await setPref(CREDS_KEY, JSON.stringify({ id: r.id, jeton: r.jeton }));
    await syncSave();
    return "ok";
  } catch {
    return "failed";
  }
}

/** Turn the cloud save back on: an account is made at the next sync. */
export async function enableCloudSave(): Promise<void> {
  await setPref(OFF_KEY, null);
  setStatus({ state: "pending", at: null, apple: false });
  await syncSave();
}

/** Turn the cloud save off: the account and its save are deleted on the relay. False if the relay couldn't be reached. */
export async function deleteAccount(): Promise<boolean> {
  const root = base();
  const creds = await loadCreds();
  if (root && creds) {
    try {
      const res = await call(`${root}/compte`, { method: "DELETE" }, creds);
      if (!res.ok && res.status !== 401) return false;
    } catch {
      return false;
    }
  }
  await setPref(CREDS_KEY, null);
  await setPref(OFF_KEY, "1");
  setStatus({ state: "off", at: null, apple: false });
  return true;
}
