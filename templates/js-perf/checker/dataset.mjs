// Input generators for the json_escape benchmark. Trusted code, verifier process only.
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

// Fixed public golden set: edge cases plus 600 seeded random strings.
export function buildDataset(seed = GOLDEN_SEED) {
  const rng = mulberry32(seed);
  const samples = [
    '',
    'plain ascii string without escapes',
    '"quoted" and \\slashed\\',
    '\b\f\n\r\t\x00\x01\x1f',
    'emoji 🚀 café naïve 日本語',
    'a'.repeat(512),
    `${'hello world '.repeat(24)}"end"\n`,
  ];
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 _-./"\\\n\t\r\x00\x1b';
  for (let i = 0; i < 600; i += 1) {
    const len = Math.floor(rng() * 180);
    let s = '';
    for (let j = 0; j < len; j += 1) s += alphabet[Math.floor(rng() * alphabet.length)];
    samples.push(s);
  }
  return samples;
}

// Fresh random strings: ASCII, control characters, BMP and astral characters (well-formed UTF-16 only,
// so native JSON.stringify stays a valid candidate).
// Every call with a new seed yields different strings, so nothing can be cached or tabulated.
const FRESH_ALPHABET = [
  ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 _-./',
  '"', '\\', '\n', '\t', '\r', '\b', '\f', '\x00', '\x01', '\x1b', '\x1f', '\x7f',
  'é', 'ß', '日', '本', '\u2028', '\u2029', '🚀', '😀',
];

export function buildFreshDataset(seed, size = 1500) {
  const rng = mulberry32(seed);
  const out = [];
  for (let i = 0; i < size; i += 1) {
    const len = Math.floor(rng() * 200);
    const dense = rng() < 0.3;
    let s = '';
    for (let j = 0; j < len; j += 1) {
      const pool = dense ? FRESH_ALPHABET.length : 66;
      s += FRESH_ALPHABET[Math.floor(rng() * pool)];
    }
    out.push(s);
  }
  return out;
}
