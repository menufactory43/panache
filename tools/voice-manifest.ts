/**
 * Export the announcer's phrase book (src/game/voice-lines.ts) to
 * public/assets/voice/manifest.json, the list tools/voice-generate.py
 * records. Run after changing any spoken line:
 *
 *   npx vite-node tools/voice-manifest.ts && python3 tools/voice-generate.py
 *
 * (tests/voice-pack.test.ts fails while the manifest or a clip is missing.)
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { voiceLines } from "../src/game/voice-lines";

const out = fileURLToPath(new URL("../public/assets/voice/manifest.json", import.meta.url));
const lines = voiceLines().map(({ key, text, tone, part, core, file }) => ({ key, text, tone, part, core, file }));
writeFileSync(out, `${JSON.stringify({ lines }, null, 1)}\n`);
console.log(`${lines.length} lines (${lines.filter((l) => l.part === "line").length} whole, ${lines.filter((l) => l.part !== "line").length} fragments) → ${out}`);
