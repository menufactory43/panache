// Ops tuning harness: can the stand-in pilots complete each op, and how many stars?
//   npx vite-node tools/ops.ts [op|all|campaign|trials] [seeds] [pilot]
import { CAMPAIGN, OPS, TRIALS } from "../src/sim/ops";
import { PILOTS } from "../tests/ops-pilots";
import { runOp } from "../tests/ops-pilots";

const which = process.argv[2] ?? "all";
const seeds = Number(process.argv[3] ?? 6);
const only = process.argv[4];
const book = which === "campaign" ? CAMPAIGN : which === "trials" ? TRIALS : OPS;
for (const op of book) {
  if (which !== "all" && which !== "campaign" && which !== "trials" && which !== op.id) continue;
  for (const [name, pilot] of Object.entries(PILOTS[op.id] ?? {})) {
    if (only ? name !== only : name === "idle" && seeds > 1) continue;
    const rows: string[] = [];
    let wins = 0;
    let stars = 0;
    const t0 = Date.now();
    for (let s = 1; s <= seeds; s++) {
      const r = runOp(op.id, pilot, s);
      const res = r.result;
      if (res?.won) wins++;
      const n = res ? (res.stars & 1) + ((res.stars >> 1) & 1) + ((res.stars >> 2) & 1) : 0;
      stars += n;
      rows.push(`${res?.won ? "W" : "L"}${"★".repeat(n)} ${Math.round(r.secs)}s ${res?.reason ?? "?"}`);
    }
    console.log(`${op.id.padEnd(22)} ${name.padEnd(10)} won ${wins}/${seeds}  stars ${(stars / seeds).toFixed(1)}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    console.log("   " + rows.join(" | "));
  }
}
