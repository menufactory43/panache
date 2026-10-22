/**
 * World hashes: battle records pin one every 100 ticks (AGENT-BATTLES.md),
 * and sound duels fold one into a trail every tick to catch two phones
 * drifting apart (SOUND-DUEL.md). Never change what worldHash covers: saved
 * records pin its values.
 */
import "./nations"; // (World.nation and the nations' unit fields)
import type { World } from "./types";

const buf = new DataView(new ArrayBuffer(8));

/** FNV-1a over the bytes of numbers. */
class Fnv {
  h = 0x811c9dc5;
  num(n: number): void {
    buf.setFloat64(0, n);
    for (let i = 0; i < 8; i++) {
      this.h ^= buf.getUint8(i);
      this.h = Math.imul(this.h, 0x01000193);
    }
  }
  str(s: string): void {
    for (let i = 0; i < s.length; i++) {
      this.h ^= s.charCodeAt(i) & 0xff;
      this.h = Math.imul(this.h, 0x01000193);
    }
  }
  hex(): string {
    return (this.h >>> 0).toString(16).padStart(8, "0");
  }
}

/** A hash of everything that matters in the world: any drift shows up within 100 ticks. */
export function worldHash(w: World): string {
  const h = new Fnv();
  h.num(w.tick);
  h.num(w.nextId);
  for (const f of ["blue", "red"] as const) {
    h.num(w.factions[f].scrap);
    h.num(w.powers.meter[f]);
    h.num(w.factions[f].pending?.remaining ?? -1);
  }
  for (const id of [...w.units.keys()].sort((a, b) => a - b)) {
    const u = w.units.get(id)!;
    h.num(id);
    h.str(u.kind);
    h.num(u.x);
    h.num(u.y);
    h.num(u.hp);
    h.str(u.order.type);
    h.num(u.cargo);
  }
  for (const id of [...w.buildings.keys()].sort((a, b) => a - b)) {
    const b = w.buildings.get(id)!;
    h.num(id);
    h.num(b.hp);
    h.num(b.queue.length);
    h.num(b.queue[0]?.remaining ?? -1);
  }
  h.num(w.projectiles.length);
  h.num(w.wrecks.length);
  for (const l of w.objectives.uplinks) h.num(l.progress);
  h.str(w.winner ?? "-");
  if (w.nation) nationHash(h, w);
  return h.hex();
}

/**
 * The nations' state (nations.ts), folded in only when the world has it: a
 * Classique world never does, so its hashes stay what they always were.
 */
function nationHash(h: Fnv, w: World): void {
  const ns = w.nation!;
  for (const id of [...w.units.keys()].sort((a, b) => a - b)) {
    const u = w.units.get(id)!;
    if (u.still === undefined && !u.entrenched && !u.tsf && u.overdrive === undefined) continue;
    h.num(id);
    h.num(u.still ?? -1);
    h.num(u.entrenched ? 1 : 0);
    h.num(u.tsf ? 1 : 0);
    h.num(u.overdrive ?? -1);
  }
  for (const id of [...w.buildings.keys()].sort((a, b) => a - b)) if (w.buildings.get(id)!.unpowered) h.num(id);
  for (const z of [...ns.reveals, ...ns.clouds]) {
    h.num(z.id);
    h.num(z.until);
  }
}
