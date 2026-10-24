import { describe, expect, it } from "vitest";
import { CRC_INIT, crcKey } from "../src/link/crc";
import type { BandRole } from "../src/link/transport";
import { RelayTransport, encodeRelayPacket, type RelayWindow } from "../src/versus/relay-transport";

/** A frame of `nbits` whose first two bits say its type (1 game, 2 lobby), the rest a pattern. */
function frame(type: 1 | 2, nbits = 120, fill = 0x5a) {
  const bits = new Uint8Array((nbits + 7) >> 3).fill(fill);
  bits[0] = (bits[0]! & 0x3f) | (type << 6);
  return { bits, nbits };
}

/** Nonces under which `role`'s session key is 0xFFFF, the lobby's CRC (crcKey's fallback). */
function noncesKeyedLikeLobby(role: BandRole): [number, number] {
  for (let h = 1; h < 64; h++) for (let g = 1; g < 65536; g++) if (crcKey(role, h, g) === CRC_INIT) return [h, g];
  throw new Error("no such nonces");
}

describe("RelayTransport's session CRC", () => {
  for (const role of ["host", "guest"] as const) {
    it(`still hears lobby frames when the friend's session key is 0xFFFF (${role})`, () => {
      const friend: BandRole = role === "host" ? "guest" : "host";
      const [h, g] = noncesKeyedLikeLobby(friend);
      const win: RelayWindow = {};
      const t = new RelayTransport({ role, win, now: () => 0, timers: null });
      const lobby = encodeRelayPacket(frame(2), CRC_INIT, "robust");
      win.__duelIn!(lobby, 120);
      expect(t.poll().map((p) => p.session)).toEqual([false]);
      t.setSessionKey(h, g);
      // (the friend's GO and every lobby frame after it, under the default CRC, which is also its key)
      win.__duelIn!(lobby, 120);
      expect(t.poll().map((p) => p.session)).toEqual([false]);
      // its game frames under that key pass as the session's
      win.__duelIn!(encodeRelayPacket(frame(1), crcKey(friend, h, g), "fast"), 120);
      expect(t.poll().map((p) => p.session)).toEqual([true]);
      expect(t.stats().rxBad).toBe(0);
    });
  }

  it("keeps each CRC to its own type: no game frame under the default, no lobby frame under a key", () => {
    const win: RelayWindow = {};
    const t = new RelayTransport({ role: "host", win, now: () => 0, timers: null });
    t.setSessionKey(11, 22);
    const key = crcKey("guest", 11, 22);
    expect(key).not.toBe(CRC_INIT);
    win.__duelIn!(encodeRelayPacket(frame(1), CRC_INIT, "fast"), 120);
    win.__duelIn!(encodeRelayPacket(frame(2), key, "fast"), 120);
    expect(t.poll()).toEqual([]);
    expect(t.stats().rxBad).toBe(2);
  });
});
