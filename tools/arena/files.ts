// Battle files on disk: where records go, writing them atomically (the dev
// viewer's follow mode re-reads the file while a battle plays), and the code
// that played them (git commit, a hash of src/sim/**).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BattleRecord } from "../../src/arena/record";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** sha256 of every file under the given src directories or files (sorted paths and contents). */
function treeHash(root: string, dirs: string[]): string {
  const h = createHash("sha256");
  const walk = (p: string): string[] => (statSync(p).isDirectory() ? readdirSync(p).sort().flatMap((n) => walk(join(p, n))) : [p]);
  for (const d of dirs) {
    let files: string[] = [];
    try {
      files = walk(join(root, d));
    } catch {
      continue; // (not there yet)
    }
    for (const p of files) {
      h.update(relative(root, p).replaceAll("\\", "/"));
      h.update("\0");
      h.update(readFileSync(p));
      h.update("\0");
    }
  }
  return h.digest("hex").slice(0, 16);
}

/** sha256 of every file under src/sim (sorted paths and contents): what decides whether a record replays here. */
export function simHash(root = ROOT): string {
  return treeHash(root, ["src/sim"]);
}

/** The sim plus the sound-duel code (DUEL.md): two phones pair only when this matches. */
export function duelHash(root = ROOT): string {
  return treeHash(root, ["src/sim", "src/versus", "src/link", "src/game/local-side.ts"]);
}

export function gitCommit(root = ROOT): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

const slug = (s: string) => s.toLowerCase().replace(/^(ai|openai|anthropic|llm):/, "").replace(/[^a-z0-9.]+/g, "-").replace(/^-|-$/g, "").slice(0, 32);

/** battles/2026-10-11-riverlands-42-gpt-6-luna-vs-ai-rush-hard.json (with -2, -3… if taken). */
export function recordPath(dir: string, map: string, seed: number, blue: string, red: string): string {
  mkdirSync(dir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const base = `${day}-${map}-${seed}-${slug(blue)}-vs-${slug(red)}`;
  for (let i = 1; ; i++) {
    const p = join(dir, `${base}${i > 1 ? `-${i}` : ""}.json`);
    try {
      statSync(p);
    } catch {
      return p;
    }
  }
}

/** Write via a temporary file and a rename, so a reader never sees half a record. */
export function writeRecord(path: string, r: BattleRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(r));
  renameSync(tmp, path);
}

export function readRecord(path: string): BattleRecord {
  const r = JSON.parse(readFileSync(path, "utf8")) as BattleRecord;
  if (r.v !== 1) throw new Error(`${path}: not a v1 battle record`);
  return r;
}
