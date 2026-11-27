#!/usr/bin/env node
// Zero-dependency differential equivalence + interleaved benchmark verifier for JS hot paths.
// The candidate runs in a separate Node process under the permission model (see sandbox.mjs).
// This process computes every verdict and takes every timing; nothing the candidate prints,
// sends or reports about itself is trusted. Each target brings its own export name, argument mode,
// reference and input generators (see target.mjs).
import { randomInt } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deriveSeed } from './dataset.mjs';
import { DEFAULT_MAX_BYTES, guardCandidateSource, rejected } from './guard.mjs';
import { withSandbox } from './sandbox.mjs';
import { candidateOutcome, findTarget, loadManifest, loadTarget } from './target.mjs';

export { DEFAULT_MAX_BYTES, guardCandidateSource };

const MIN_IMPROVEMENT_RATIO = 0.05;
const PAIRS = 8;
const WARMUP_ROUNDS = 5;
const BENCH_ROUNDS = 4;
const MIN_WIN_RATIO = 0.75;
const FRESH_EQUIVALENCE_SIZE = 1500;

// 48-bit master seed; every dataset seed is derived from it with SHA-256 (see dataset.mjs).
export function randomSeed() {
  return randomInt(1, 2 ** 48);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

const sandboxOptions = (source, target) => ({ source, exportName: target.exportName, spread: target.spread });

// Runs `box` on `inputs` and compares every outcome with `expected`. Returns timing on success.
async function runChecked(box, inputs, expected, label) {
  const res = await box.run(inputs);
  if (!res.ok) return { ok: false, reasonCode: res.code, reason: res.reason };
  for (let i = 0; i < inputs.length; i += 1) {
    const got = candidateOutcome(res.results[i]);
    if (got === expected[i]) continue;
    if (got === 't') return { ok: false, reasonCode: 'trapped', reason: `candidate threw on ${label} sample ${i}` };
    return { ok: false, reasonCode: 'wrong_answer', reason: `output mismatch at ${label} sample ${i}` };
  }
  return { ok: true, elapsedNs: res.elapsedNs };
}

async function checkEquivalence(box, target, seed) {
  const golden = target.golden();
  const fresh = target.fresh(deriveSeed(seed, 'equivalence'), FRESH_EQUIVALENCE_SIZE);
  const a = await runChecked(box, golden, target.expect(golden), 'golden');
  if (!a.ok) return a;
  return runChecked(box, fresh, target.expect(fresh), 'fresh');
}

// Runs every round of one side in its own sandbox, one request per round (warm-up included), and
// returns the parent-measured time of each. The other side is not alive at the same time, so a
// candidate cannot disturb the holder's timing.
function timeSide({ source, rounds, target, seed, check }) {
  return withSandbox(sandboxOptions(source, target), async (box) => {
    if (check) {
      const eq = await checkEquivalence(box, target, seed);
      if (!eq.ok) return eq;
    }
    const times = [];
    for (let r = 0; r < rounds.length; r += 1) {
      const res = await runChecked(box, rounds[r].data, rounds[r].expected, `round ${r}`);
      if (!res.ok) return res;
      times.push(res.elapsedNs);
    }
    return { ok: true, times: times.slice(WARMUP_ROUNDS) };
  });
}

// Two fresh processes can differ by a few percent for identical code (JIT and heap layout), so the
// benchmark is repeated in PAIRS independent process pairs, alternating which side runs first, and the
// results are pooled. Round k of the holder and of the candidate use the same, never-reused, dataset.
async function benchmark({ holderSource, candSource, target, seed }) {
  const pairs = [];
  for (let p = 0; p < PAIRS; p += 1) {
    const rounds = [];
    for (let r = 0; r < WARMUP_ROUNDS + BENCH_ROUNDS; r += 1) {
      const data = target.fresh(deriveSeed(seed, 'round', p, r), target.roundSize);
      rounds.push({ data, expected: target.expect(data) });
    }
    const out = {};
    for (const side of p % 2 === 0 ? ['holder', 'cand'] : ['cand', 'holder']) {
      const source = side === 'holder' ? holderSource : candSource;
      out[side] = await timeSide({ source, rounds, target, seed, check: p === 0 });
      if (!out[side].ok) return { ...out[side], side };
    }
    pairs.push({ holderTimes: out.holder.times, candTimes: out.cand.times });
  }
  return { ok: true, pairs };
}

/** Judges one candidate file against the holder for the target `targetName` in `manifestPath`. */
export async function verifyCandidateFiles({ candidatePath, holderPath, manifestPath, targetName, seed = randomSeed() }) {
  const { rootDir, manifest } = loadManifest(manifestPath);
  const spec = findTarget(manifest, targetName);
  if (!spec) return rejected('schema_error', 'unknown target');
  const raw = readFileSync(candidatePath, 'utf8');
  const guardError = guardCandidateSource(raw, manifest.max_bytes ?? DEFAULT_MAX_BYTES, spec.export ?? 'jsonEscape');
  if (guardError) return guardError;

  let target;
  try {
    target = await loadTarget(rootDir, spec);
  } catch {
    return rejected('fault', 'verifier could not load the target oracle');
  }
  const fuel = JSON.stringify({ pairs: PAIRS, rounds: BENCH_ROUNDS, round_size: target.roundSize, seed });
  const bench = await benchmark({ holderSource: readFileSync(holderPath, 'utf8'), candSource: raw, target, seed });
  if (!bench.ok) {
    if (bench.side === 'holder') return rejected('fault', `holder baseline failed eval: ${bench.reason}`, { class_fuel: fuel });
    return rejected(bench.reasonCode, bench.reason, { class_fuel: fuel });
  }
  return scoreVerdict({ raw, pairs: bench.pairs, fuel });
}

// Gain = median over process pairs of (1 - median of that pair's per-round candidate/holder ratios).
// The candidate must also win at least MIN_WIN_RATIO of all paired rounds.
function scoreVerdict({ raw, pairs, fuel }) {
  const holderTimes = pairs.flatMap((p) => p.holderTimes);
  const candTimes = pairs.flatMap((p) => p.candTimes);
  const holderScore = Math.max(1, Math.round(median(holderTimes) / 1000));
  const candScore = Math.max(1, Math.round(median(candTimes) / 1000));
  const pairGains = pairs.map((p) => 1 - median(p.candTimes.map((t, i) => t / p.holderTimes[i])));
  // Median, not mean: one pair hit by a burst of load on a shared runner cannot swing the verdict.
  const gain = median(pairGains);
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

async function selfCheckOne(rootDir, manifest, spec, seed) {
  const raw = readFileSync(resolve(rootDir, spec.file_path), 'utf8');
  const guardError = guardCandidateSource(raw, manifest.max_bytes ?? DEFAULT_MAX_BYTES, spec.export ?? 'jsonEscape');
  if (guardError) return { target: spec.name, ok: false, reason_code: guardError.reason_code, reason: guardError.reason };
  let target;
  try {
    target = await loadTarget(rootDir, spec);
  } catch (err) {
    return { target: spec.name, ok: false, reason_code: 'fault', reason: `could not load target: ${err.message}` };
  }
  const res = await withSandbox(sandboxOptions(raw, target), (box) => checkEquivalence(box, target, seed));
  if (!res.ok) return { target: spec.name, ok: false, reason_code: res.reasonCode, reason: res.reason };
  return { target: spec.name, ok: true, samples: target.golden().length, seed };
}

/** Checks that every target's record file matches its reference on golden and fresh inputs. */
export async function verifySelfCheck(manifestPath, { seed = randomSeed() } = {}) {
  const { rootDir, manifest } = loadManifest(manifestPath);
  const results = [];
  for (const spec of manifest.targets ?? []) results.push(await selfCheckOne(rootDir, manifest, spec, seed));
  return { ok: results.every((r) => r.ok), checked: results.length, results };
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
  const { rootDir, manifest } = loadManifest(manifestPath);
  const spec = findTarget(manifest, flags.target);
  if (!spec) return emitVerdict(rejected('schema_error', 'unknown target'), flags.out);
  const verdict = await verifyCandidateFiles({
    candidatePath: resolve(flags.candidate),
    holderPath: flags.holder ? resolve(flags.holder) : resolve(rootDir, spec.file_path),
    manifestPath,
    targetName: spec.name,
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
