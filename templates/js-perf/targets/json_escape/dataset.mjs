// Inputs for json_escape: one string per input (args "single"). Trusted code, verifier process only.
import { GOLDEN_SEED, mulberry32 } from '../../checker/dataset.mjs';

// Edge cases plus 600 strings drawn from `seed`.
function buildDataset(seed) {
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

export function fresh(seed, size = 1500) {
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

// Fixed public golden set: edge cases plus 600 seeded random strings.
export function golden() {
  return buildDataset(GOLDEN_SEED);
}
