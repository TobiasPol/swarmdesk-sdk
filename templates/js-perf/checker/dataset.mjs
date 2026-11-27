// Seed helpers shared by every target's dataset.mjs. Trusted code, verifier process only.
import { createHash } from 'node:crypto';

export const GOLDEN_SEED = 20261127;

// Independent 32-bit generator seed per purpose: the candidate cannot predict a later round's inputs
// from earlier ones without brute-forcing the wide master seed through SHA-256.
export function deriveSeed(master, ...labels) {
  return createHash('sha256').update([master, ...labels].join(':')).digest().readUInt32BE(0);
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
