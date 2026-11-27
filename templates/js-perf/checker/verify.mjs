#!/usr/bin/env node
// Zero-dependency differential equivalence + interleaved benchmark verifier for JS/TS hot paths.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_MAX_BYTES = 65536;
const MIN_IMPROVEMENT_RATIO = 0.05;
const WARMUP_ITERS = 3;
const BENCH_ROUNDS = 6;

const FORBIDDEN_PATTERNS = [
  [/\/\//, 'single-line comments are not allowed'],
  [/\/\*/, 'block comments are not allowed'],
  [/\bimport\b/, 'import statements are not allowed'],
  [/\brequire\s*\(/, 'require() is not allowed'],
  [/\beval\s*\(/, 'eval() is not allowed'],
  [/\bFunction\s*\(/, 'Function constructor is not allowed'],
  [/\bprocess\b/, 'process access is not allowed'],
  [/\bglobalThis\b/, 'globalThis access is not allowed'],
  [/\bProxy\b/, 'Proxy is not allowed'],
  [/__proto__/, '__proto__ access is not allowed'],
  [/\bReflect\b/, 'Reflect is not allowed'],
  [/\bfetch\s*\(/, 'network calls are not allowed'],
];

function rejected(reasonCode, reason, extra = {}) {
  return {
    verdict: 'REJECTED',
    reason_code: reasonCode,
    reason,
    resolution: '',
    metric_value: extra.metric_value ?? null,
    holder_value: extra.holder_value ?? null,
    proof_lines: 0,
    wasm_bytes: 0,
    class_fuel: '{}',
  };
}

export function guardCandidateSource(rawText, maxBytes = DEFAULT_MAX_BYTES) {
  if (typeof rawText !== 'string' || rawText.trim().length === 0) {
    return rejected('schema_error', 'submission file is empty');
  }
  if (Buffer.byteLength(rawText, 'utf8') > maxBytes) {
    return rejected('size_limit', `submission exceeds ${maxBytes} bytes`);
  }
  if (rawText.includes('\0') || rawText.charCodeAt(0) === 0xfeff) {
    return rejected('guard_rejected', 'submission contains invalid control bytes');
  }
  for (const [pattern, message] of FORBIDDEN_PATTERNS) {
    if (pattern.test(rawText)) {
      return rejected('guard_rejected', message);
    }
  }
  if (!/export\s+function\s+jsonEscape\s*\(/.test(rawText)) {
    return rejected('schema_error', 'candidate must export function jsonEscape');
  }
  return null;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildDataset(seed = 20261127) {
  const rng = mulberry32(seed);
  const edgeCases = [
    '',
    'plain ascii string without escapes',
    '"quoted" and \\slashed\\',
    '\b\f\n\r\t\x00\x01\x1f',
    'emoji 🚀 café naïve 日本語',
    'a'.repeat(512),
    `${'hello world '.repeat(24)}"end"\n`,
  ];
  const samples = [...edgeCases];
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 _-./"\\\n\t\r\x00\x1b';
  for (let i = 0; i < 600; i += 1) {
    const len = Math.floor(rng() * 180);
    let s = '';
    for (let j = 0; j < len; j += 1) {
      s += alphabet[Math.floor(rng() * alphabet.length)];
    }
    samples.push(s);
  }
  return samples;
}

async function loadFn(filePath) {
  const url = `${pathToFileURL(resolve(filePath)).href}?t=${Date.now()}_${Math.random()}`;
  const mod = await import(url);
  if (typeof mod.jsonEscape !== 'function') {
    throw new Error('module does not export jsonEscape');
  }
  return mod.jsonEscape;
}

function runBatch(fn, dataset, repeats) {
  let sink = 0;
  const start = process.hrtime.bigint();
  for (let r = 0; r < repeats; r += 1) {
    for (let i = 0; i < dataset.length; i += 1) {
      sink ^= fn(dataset[i]).length;
    }
  }
  const elapsedNs = Number(process.hrtime.bigint() - start);
  return { elapsedNs, sink };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export async function verifyCandidateFiles({ candidatePath, holderPath, referencePath, maxBytes = DEFAULT_MAX_BYTES }) {
  const raw = readFileSync(candidatePath, 'utf8');
  const guardError = guardCandidateSource(raw, maxBytes);
  if (guardError) return guardError;

  let refFn;
  let holderFn;
  let candFn;
  try {
    refFn = await loadFn(referencePath);
    holderFn = await loadFn(holderPath);
    candFn = await loadFn(candidatePath);
  } catch (err) {
    return rejected('compile_error', `failed to load module: ${err instanceof Error ? err.message : 'unknown'}`);
  }

  const dataset = buildDataset(20261127);
  for (let i = 0; i < dataset.length; i += 1) {
    const expected = refFn(dataset[i]);
    let actual;
    try {
      actual = candFn(dataset[i]);
    } catch {
      return rejected('trapped', `candidate threw on sample ${i}`);
    }
    if (actual !== expected) {
      return rejected('wrong_answer', `output mismatch at sample ${i}`);
    }
  }

  for (let w = 0; w < WARMUP_ITERS; w += 1) {
    runBatch(holderFn, dataset, 2);
    runBatch(candFn, dataset, 2);
  }

  const holderTimes = [];
  const candTimes = [];
  for (let r = 0; r < BENCH_ROUNDS; r += 1) {
    if (r % 2 === 0) {
      holderTimes.push(runBatch(holderFn, dataset, 8).elapsedNs);
      candTimes.push(runBatch(candFn, dataset, 8).elapsedNs);
    } else {
      candTimes.push(runBatch(candFn, dataset, 8).elapsedNs);
      holderTimes.push(runBatch(holderFn, dataset, 8).elapsedNs);
    }
  }

  const holderScore = Math.max(1, Math.round(median(holderTimes) / 1000));
  const candScore = Math.max(1, Math.round(median(candTimes) / 1000));
  const gain = (holderScore - candScore) / holderScore;

  if (gain < MIN_IMPROVEMENT_RATIO) {
    return rejected(
      'bound_not_improved',
      `median cost ${candScore} does not beat holder ${holderScore} by at least 5%`,
      { metric_value: candScore, holder_value: holderScore },
    );
  }

  return {
    verdict: 'ACCEPTED',
    reason_code: '',
    reason: `verified equivalence on ${dataset.length} samples; cost ${candScore} < holder ${holderScore} (${(gain * 100).toFixed(1)}% cut)`,
    resolution: 'improved',
    metric_value: candScore,
    holder_value: holderScore,
    proof_lines: raw.split('\n').length,
    wasm_bytes: 0,
    class_fuel: JSON.stringify({ samples: dataset.length, rounds: BENCH_ROUNDS }),
  };
}

export async function verifySelfCheck(manifestPath) {
  const absManifest = resolve(manifestPath);
  const rootDir = dirname(absManifest);
  const manifest = JSON.parse(readFileSync(absManifest, 'utf8'));
  const results = [];
  let allOk = true;

  for (const target of manifest.targets ?? []) {
    const candPath = resolve(rootDir, target.file_path);
    const refPath = resolve(rootDir, 'targets', target.name, 'reference.mjs');
    const raw = readFileSync(candPath, 'utf8');
    const guardError = guardCandidateSource(raw, manifest.max_bytes ?? DEFAULT_MAX_BYTES);
    if (guardError) {
      allOk = false;
      results.push({ target: target.name, ok: false, reason_code: guardError.reason_code, reason: guardError.reason });
      continue;
    }
    const refFn = await loadFn(refPath);
    const candFn = await loadFn(candPath);
    const dataset = buildDataset(20261127);
    const mismatch = dataset.findIndex((s) => candFn(s) !== refFn(s));
    if (mismatch !== -1) {
      allOk = false;
      results.push({ target: target.name, ok: false, reason_code: 'wrong_answer', reason: `mismatch at ${mismatch}` });
      continue;
    }
    results.push({ target: target.name, ok: true, samples: dataset.length });
  }
  return { ok: allOk, checked: results.length, results };
}

function parseFlags(args) {
  const out = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const val = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : 'true';
      out[key] = val;
    }
  }
  return out;
}

async function main(argv) {
  if (argv[0] === '--self-check') {
    const res = await verifySelfCheck(argv[1] ?? 'targets.json');
    console.log(JSON.stringify(res, null, 2));
    process.exit(res.ok ? 0 : 1);
  }
  if (argv[0] === 'verify') {
    const flags = parseFlags(argv.slice(1));
    const manifestPath = resolve(flags.targets ?? 'targets.json');
    const rootDir = dirname(manifestPath);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const targetSpec = (manifest.targets ?? []).find((t) => t.name === flags.target);
    if (!targetSpec) {
      const err = rejected('schema_error', 'unknown target');
      if (flags.out) writeFileSync(flags.out, `${JSON.stringify(err)}\n`);
      console.log(JSON.stringify(err));
      process.exit(0);
    }
    const verdict = await verifyCandidateFiles({
      candidatePath: resolve(flags.candidate),
      holderPath: flags.holder ? resolve(flags.holder) : resolve(rootDir, targetSpec.file_path),
      referencePath: resolve(rootDir, 'targets', targetSpec.name, 'reference.mjs'),
      maxBytes: manifest.max_bytes ?? DEFAULT_MAX_BYTES,
    });
    if (flags.out) writeFileSync(flags.out, `${JSON.stringify(verdict)}\n`);
    console.log(JSON.stringify(verdict));
    process.exit(0);
  }
  console.error('usage: verify.mjs --self-check [targets.json] | verify --targets <targets.json> --target <name> --candidate <file> [--holder <file>] [--out <final.json>]');
  process.exit(2);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main(process.argv.slice(2));
}
