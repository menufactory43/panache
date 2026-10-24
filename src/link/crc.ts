/**
 * The packet CRC (DUEL.md "The modem" > Transmitter): CRC-16/CCITT,
 * polynomial 0x1021, MSB-first over the payload bits, no final XOR. Lobby
 * frames start the register at 0xFFFF. Game frames start it at the session
 * key, which only the two phones of this pairing derive, so a recording of
 * another match (or a second pair of phones in the room) fails its CRC.
 */
import { hash32 } from "../sim/rand";
import type { BandRole } from "./transport";

/** The register's start for frames outside a session. */
export const CRC_INIT = 0xffff;

/** CRC over `n` bits given one per element (0 or 1), starting from `init`. */
export function crc16(bits: ArrayLike<number>, n: number, init: number, from = 0): number {
  let c = init & 0xffff;
  for (let i = 0; i < n; i++) {
    const top = ((c >> 15) ^ bits[from + i]!) & 1;
    c = (c << 1) & 0xffff;
    if (top) c ^= 0x1021;
  }
  return c;
}

/** The session key of the phone transmitting as `role` (never 0, which would weaken the CRC). */
export function crcKey(role: BandRole, hostNonce: number, guestNonce: number): number {
  return hash32(hostNonce, guestNonce, 7, role === "host" ? 0 : 1) & 0xffff || 0xffff;
}
