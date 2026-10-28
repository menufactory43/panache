/**
 * The storage keys were « battledrones.* » (the game Panache started from) and are « panache.* » now.
 * Imported first by main.ts, before anything reads them: each old key still on this device moves to
 * its new name (a key already under the new name wins), so no player loses a career, a setting or a
 * lesson done. The cloud save's flags are renamed the same way (game/save.ts, LEGACY_PREFIX).
 */
export const LEGACY_PREFIX = "battledrones.";

/** Moves every « battledrones.x » to « panache.x » in one storage. Engine-free; exported for tests. */
export function renameLegacyKeys(store: Storage): void {
  const old: string[] = [];
  for (let i = 0; i < store.length; i++) {
    const k = store.key(i);
    if (k?.startsWith(LEGACY_PREFIX)) old.push(k);
  }
  for (const k of old) {
    const to = `panache.${k.slice(LEGACY_PREFIX.length)}`;
    const v = store.getItem(k);
    if (v !== null && store.getItem(to) === null) store.setItem(to, v);
    store.removeItem(k);
  }
}

for (const s of ["localStorage", "sessionStorage"] as const) {
  try {
    renameLegacyKeys(globalThis[s]);
  } catch {
    // no storage here (private browsing, a test): nothing to move
  }
}
