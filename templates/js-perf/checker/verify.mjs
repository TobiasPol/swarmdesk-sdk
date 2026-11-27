#!/usr/bin/env node
// Zero-dependency differential equivalence + interleaved benchmark verifier for JS hot paths.
// The candidate runs in a separate Node process under the permission model (see sandbox.mjs).
// This process computes every verdict and takes every timing; nothing the candidate prints,
// sends or reports about itself is trusted.
import { randomInt } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildDataset, buildFreshDataset, deriveSeed, GOLDEN_SEED } from './dataset.mjs';
import { startSandbox, withSandbox } from './sandbox.mjs';

export const DEFAULT_MAX_BYTES = 65536;
const MIN_IMPROVEMENT_RATIO = 0.05;
const PAIRS = 4;
const WARMUP_ROUNDS = 3;
const BENCH_ROUNDS = 6;
const MIN_WIN_RATIO = 0.75;
const ROUND_SIZE = 4800;

// Cheap first filter only. The security boundary is the sandbox, not this list.
const FORBIDDEN_PATTERNS = [
  [/\/\//, 'single-line comments are not allowed'],
  [/\/\*/, 'block comments are not allowed'],
  [/\bimport\b/, 'import statements are not allowed'],
  [/\brequire\s*\(/, 'require() is not allowed'],
  [/\beval\s*\(/, 'eval() is not allowed'],
  [/\bFunction\s*\(/, 'Function constructor is not allowed'],
  [/\bconstructor\b/, 'constructor access is not allowed'],
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
    class_fuel: extra.class_fuel ?? '{}',
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
    if (pattern.test(rawText)) return rejected('guard_rejected', message);
  }
  if (!/export\s+function\s+jsonEscape\s*\(/.test(rawText)) {
    return rejected('schema_error', 'candidate must export function jsonEscape');
  }
  return null;
}

// 48-bit master seed; every dataset seed is derived from it with SHA-256 (see dataset.mjs).
export function randomSeed() {
  return randomInt(1, 2 ** 48);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

async function loadReference(referencePath) {
  const mod = await import(pathToFileURL(resolve(referencePath)).href);
  if (typeof mod.jsonEscape !== 'function') throw new Error('reference lacks jsonEscape');
  return mod.jsonEscape;
}

// Runs `box` on `inputs` and compares every output with `expected`. Returns timing on success.
async function runChecked(box, inputs, expected, label) {
  const res = await box.run(inputs);
  if (!res.ok) return { ok: false, reasonCode: res.code, reason: res.reason };
  for (let i = 0; i < inputs.length; i += 1) {
    if (!res.results[i].ok) return { ok: false, reasonCode: 'trapped', reason: `candidate threw on ${label} sample ${i}` };
    if (res.results[i].value !== expected[i]) {
      return { ok: false, reasonCode: 'wrong_answer', reason: `output mismatch at ${label} sample ${i}` };
    }
  }
  return { ok: true, elapsedNs: res.elapsedNs };
}

async function checkEquivalence(box, refFn, seed) {
  const golden = buildDataset(GOLDEN_SEED);
  const fresh = buildFreshDataset(deriveSeed(seed, 'equivalence'));
  const a = await runChecked(box, golden, golden.map(refFn), 'golden');
  if (!a.ok) return a;
  return runChecked(box, fresh, fresh.map(refFn), 'fresh');
}

// Times one round on `active` while `idle` is frozen (SIGSTOP), so the side that is not being timed
// cannot use CPU, whatever it runs between requests.
function timedRound(active, idle, round, label) {
  idle.pause();
  active.resume();
  return runChecked(active, round.data, round.expected, label);
}

// Two fresh processes can differ by a few percent for identical code (JIT and heap layout), so the
// benchmark is repeated in PAIRS independent process pairs and pooled. Within a pair the sides
// alternate round by round, and which side goes first alternates too, so drift in machine load hits
// both sides alike. Round k of both sides uses the same, never-reused dataset.
async function timePair({ holderSource, candSource, refFn, seed, p }) {
  const boxes = {
    holder: startSandbox({ source: holderSource, exportName: 'jsonEscape' }),
    cand: startSandbox({ source: candSource, exportName: 'jsonEscape' }),
  };
  try {
    for (const side of p === 0 ? ['holder', 'cand'] : []) {
      const eq = await checkEquivalence(boxes[side], refFn, seed);
      if (!eq.ok) return { ...eq, side };
    }
    const times = { holder: [], cand: [] };
    for (let r = 0; r < WARMUP_ROUNDS + BENCH_ROUNDS; r += 1) {
      const data = buildFreshDataset(deriveSeed(seed, 'round', p, r), ROUND_SIZE);
      const round = { data, expected: data.map(refFn) };
      for (const side of (p + r) % 2 === 0 ? ['holder', 'cand'] : ['cand', 'holder']) {
        const idle = boxes[side === 'holder' ? 'cand' : 'holder'];
        const res = await timedRound(boxes[side], idle, round, `round ${r}`);
        if (!res.ok) return { ...res, side };
        times[side].push(res.elapsedNs);
      }
    }
    const skip = (xs) => xs.slice(WARMUP_ROUNDS);
    return { ok: true, holderTimes: skip(times.holder), candTimes: skip(times.cand) };
  } finally {
    boxes.holder.close();
    boxes.cand.close();
  }
}

async function benchmark({ holderSource, candSource, refFn, seed }) {
  const pairs = [];
  for (let p = 0; p < PAIRS; p += 1) {
    const pair = await timePair({ holderSource, candSource, refFn, seed, p });
    if (!pair.ok) return pair;
    pairs.push({ holderTimes: pair.holderTimes, candTimes: pair.candTimes });
  }
  return { ok: true, pairs };
}

export async function verifyCandidateFiles({
  candidatePath,
  holderPath,
  referencePath,
  maxBytes = DEFAULT_MAX_BYTES,
  seed = randomSeed(),
}) {
  const raw = readFileSync(candidatePath, 'utf8');
  const guardError = guardCandidateSource(raw, maxBytes);
  if (guardError) return guardError;

  let refFn;
  try {
    refFn = await loadReference(referencePath);
  } catch {
    return rejected('fault', 'verifier could not load the target oracle');
  }
  const fuel = JSON.stringify({ pairs: PAIRS, rounds: BENCH_ROUNDS, round_size: ROUND_SIZE, seed });
  const bench = await benchmark({ holderSource: readFileSync(holderPath, 'utf8'), candSource: raw, refFn, seed });
  if (!bench.ok) {
    if (bench.side === 'holder') return rejected('fault', `holder baseline failed eval: ${bench.reason}`, { class_fuel: fuel });
    return rejected(bench.reasonCode, bench.reason, { class_fuel: fuel });
  }
  return scoreVerdict({ raw, pairs: bench.pairs, fuel });
}

// Gain = mean over process pairs of (1 - median of that pair's per-round candidate/holder ratios).
// The candidate must also win at least MIN_WIN_RATIO of all paired rounds.
function scoreVerdict({ raw, pairs, fuel }) {
  const holderTimes = pairs.flatMap((p) => p.holderTimes);
  const candTimes = pairs.flatMap((p) => p.candTimes);
  const holderScore = Math.max(1, Math.round(median(holderTimes) / 1000));
  const candScore = Math.max(1, Math.round(median(candTimes) / 1000));
  const pairGains = pairs.map((p) => 1 - median(p.candTimes.map((t, i) => t / p.holderTimes[i])));
  const gain = pairGains.reduce((a, b) => a + b, 0) / pairGains.length;
  const ratios = candTimes.map((t, i) => t / holderTimes[i]);
  const wins = ratios.filter((x) => x < 1).length;
  if (gain < MIN_IMPROVEMENT_RATIO || wins < Math.ceil(MIN_WIN_RATIO * ratios.length)) {
    return rejected(
      'bound_not_improved',
      `median cost ${candScore} does not beat holder ${holderScore} by at least 5% (won ${wins}/${ratios.length} rounds)`,
      { metric_value: candScore, holder_value: holderScore, class_fuel: fuel },
    );
  }
  return {
    verdict: 'ACCEPTED',
    reason_code: '',
    reason: `verified equivalence on golden + fresh samples; median round cost ${candScore} < holder ${holderScore} (${(gain * 100).toFixed(1)}% cut, won ${wins}/${ratios.length} rounds)`,
    resolution: 'improved',
    metric_value: candScore,
    holder_value: holderScore,
    proof_lines: raw.split('\n').length,
    wasm_bytes: 0,
    class_fuel: fuel,
  };
}

export async function verifySelfCheck(manifestPath, { seed = randomSeed() } = {}) {
  const absManifest = resolve(manifestPath);
  const rootDir = dirname(absManifest);
  const manifest = JSON.parse(readFileSync(absManifest, 'utf8'));
  const results = [];
  let allOk = true;

  for (const target of manifest.targets ?? []) {
    const raw = readFileSync(resolve(rootDir, target.file_path), 'utf8');
    const guardError = guardCandidateSource(raw, manifest.max_bytes ?? DEFAULT_MAX_BYTES);
    if (guardError) {
      allOk = false;
      results.push({ target: target.name, ok: false, reason_code: guardError.reason_code, reason: guardError.reason });
      continue;
    }
    const refFn = await loadReference(resolve(rootDir, 'targets', target.name, 'reference.mjs'));
    const res = await withSandbox({ source: raw, exportName: 'jsonEscape' }, (box) => checkEquivalence(box, refFn, seed));
    if (!res.ok) {
      allOk = false;
      results.push({ target: target.name, ok: false, reason_code: res.reasonCode, reason: res.reason });
      continue;
    }
    results.push({ target: target.name, ok: true, samples: buildDataset(GOLDEN_SEED).length, seed });
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

function emitVerdict(verdict, outPath) {
  const line = `${JSON.stringify(verdict)}\n`;
  if (outPath) writeFileSync(outPath, line);
  process.stdout.write(line);
}

async function runVerify(flags) {
  const manifestPath = resolve(flags.targets ?? 'targets.json');
  const rootDir = dirname(manifestPath);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const targetSpec = (manifest.targets ?? []).find((t) => t.name === flags.target);
  if (!targetSpec) return emitVerdict(rejected('schema_error', 'unknown target'), flags.out);
  const verdict = await verifyCandidateFiles({
    candidatePath: resolve(flags.candidate),
    holderPath: flags.holder ? resolve(flags.holder) : resolve(rootDir, targetSpec.file_path),
    referencePath: resolve(rootDir, 'targets', targetSpec.name, 'reference.mjs'),
    maxBytes: manifest.max_bytes ?? DEFAULT_MAX_BYTES,
    seed: flags.seed ? Number.parseInt(flags.seed, 10) : randomSeed(),
  });
  return emitVerdict(verdict, flags.out);
}

async function main(argv) {
  if (argv[0] === '--self-check') {
    const res = await verifySelfCheck(argv[1] ?? 'targets.json');
    console.log(JSON.stringify(res, null, 2));
    process.exit(res.ok ? 0 : 1);
  }
  if (argv[0] === 'verify') {
    await runVerify(parseFlags(argv.slice(1)));
    process.exit(0);
  }
  console.error(
    'usage: verify.mjs --self-check [targets.json] | verify --targets <targets.json> --target <name> --candidate <file> [--holder <file>] [--seed <n>] [--out <final.json>]',
  );
  process.exit(2);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main(process.argv.slice(2));
}
