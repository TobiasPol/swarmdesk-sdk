// Inputs for parse_range: [size, header] argument lists (args "spread"). Trusted code, verifier
// process only. Headers mix valid ranges, suffix ranges, open ends, overlaps, whitespace, other
// units and malformed specs, so a candidate must keep every branch of the reference.
import { GOLDEN_SEED, mulberry32 } from '../../checker/dataset.mjs';

const FIXED = [
  [1000, 'bytes=0-499'],
  [1000, 'bytes=0-499,500-999'],
  [1000, 'bytes=500-'],
  [1000, 'bytes=-200'],
  [1000, 'bytes=-0'],
  [1000, 'bytes=0-0,-1'],
  [1000, 'bytes=900-1200'],
  [1000, 'bytes=1000-'],
  [1000, 'bytes=5-3'],
  [1000, 'bytes=abc'],
  [1000, 'bytes='],
  [1000, 'bytes=,'],
  [1000, '=0-1'],
  [1000, 'BYTES = 0 - 10 , 5 - 20'],
  [1000, 'items=0-9,20-29,10-19'],
  [1000, 'bytes=0-1,2-3,4-5'],
  [0, 'bytes=0-'],
  [0, 'bytes=-5'],
  [1, 'bytes=0-0'],
  [2 ** 31, 'bytes=0-99999999999'],
  [1000, 'bytes 0-10'],
  [1000, 'by-tes=0-10'],
];

const UNITS = ['bytes', 'bytes', 'bytes', 'bytes', 'BYTES', 'Bytes', 'items'];
const BAD_UNITS = ['', 'by tes', '7', 'by-tes'];
const SPACES = ['', '', '', ' ', '  ', '\t'];

function pick(rng, list) {
  return list[Math.floor(rng() * list.length)];
}

function number(rng, size) {
  const r = rng();
  if (r < 0.15) return 0;
  if (r < 0.3) return Math.max(0, size - 1 - Math.floor(rng() * 3));
  if (r < 0.4) return size + Math.floor(rng() * 50);
  return Math.floor(rng() * Math.max(1, size * 1.1));
}

function spec(rng, size) {
  const sp = () => pick(rng, SPACES);
  const r = rng();
  if (r < 0.45) {
    const a = number(rng, size);
    const b = rng() < 0.1 ? Math.max(0, a - 1 - Math.floor(rng() * 5)) : a + Math.floor(rng() * size);
    return `${sp()}${a}${sp()}-${sp()}${b}${sp()}`;
  }
  if (r < 0.65) return `${sp()}${number(rng, size)}-${sp()}`;
  if (r < 0.85) return `${sp()}-${Math.floor(rng() * (size + 10))}${sp()}`;
  if (r < 0.9) return '';
  return pick(rng, ['-', 'x-1', '1-y', '12', '1--2', '-1-', ' - ', '0x1-2', '1.5-2']);
}

function header(rng, size) {
  const n = 1 + Math.floor(rng() * 6);
  const specs = [];
  for (let i = 0; i < n; i += 1) specs.push(spec(rng, size));
  const unit = rng() < 0.05 ? pick(rng, BAD_UNITS) : pick(rng, UNITS);
  return rng() < 0.03 ? `${unit} ${specs.join(',')}` : `${unit}${pick(rng, SPACES)}=${specs.join(',')}`;
}

function sizeOf(rng) {
  const r = rng();
  if (r < 0.05) return 0;
  if (r < 0.5) return 1 + Math.floor(rng() * 2000);
  return Math.floor(rng() * 2 ** 31);
}

export function fresh(seed, size = 1500) {
  const rng = mulberry32(seed);
  const out = [];
  for (let i = 0; i < size; i += 1) {
    const total = sizeOf(rng);
    out.push([total, header(rng, total)]);
  }
  return out;
}

// Fixed public golden set: the cases above plus 400 seeded random headers.
export function golden() {
  return [...FIXED, ...fresh(GOLDEN_SEED, 400)];
}
