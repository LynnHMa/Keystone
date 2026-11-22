import { randomBytes } from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let lastTime = 0;
let lastRand = new Uint8Array(10);

function encodeTime(ms: number): string {
  let out = "";
  let v = ms;
  for (let i = 0; i < 10; i++) {
    out = CROCKFORD[v % 32] + out;
    v = Math.floor(v / 32);
  }
  return out;
}

function encodeRandom(bytes: Uint8Array): string {
  // 80 bits -> 16 base32 chars
  let out = "";
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD[(value >>> bits) & 31];
    }
  }
  return out.slice(0, 16);
}

function incrementBytes(bytes: Uint8Array): void {
  for (let i = bytes.length - 1; i >= 0; i--) {
    if (bytes[i] < 255) {
      bytes[i] += 1;
      return;
    }
    bytes[i] = 0;
  }
}

/**
 * Generates a lexicographically sortable, monotonic 26-char ULID.
 * Used as conflict-free identifiers for append-only memory files across devices.
 */
export function ulid(now = Date.now()): string {
  if (now === lastTime) {
    incrementBytes(lastRand);
  } else {
    lastTime = now;
    lastRand = randomBytes(10);
  }
  return encodeTime(now) + encodeRandom(lastRand);
}
