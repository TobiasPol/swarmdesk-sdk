#!/usr/bin/env node
// Zero-dependency business-rule, VAT compliance and LLM cost verifier.
// The candidate runs in a separate Node process under the permission model (see sandbox.mjs).
// This process computes every verdict; nothing the candidate prints or sends is trusted.
import { randomInt } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { withSandbox } from './sandbox.mjs';

export const DEFAULT_MAX_BYTES = 65536;
const MIN_IMPROVEMENT_RATIO = 0.05;

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
  if (!/export\s+function\s+routeAndPrice\s*\(/.test(rawText)) {
    return rejected('schema_error', 'candidate must export function routeAndPrice');
  }
  return null;
}

async function loadTargetModules(targetDir) {
  const load = (name) => import(pathToFileURL(resolve(targetDir, name)).href);
  const [ref, scn] = await Promise.all([load('reference.mjs'), load('scenarios.mjs')]);
  return { ref, scn };
}

// Runs `source` on `scenarios` in a sandbox. The candidate never sees scenario ids and always gets
// its own JSON copy; the decisions it returns are JSON text that is re-validated here.
async function evaluateSuite({ source, scenarios, goldenCount, ref }) {
  const inputs = scenarios.map(({ id: _id, ...fields }) => fields);
  const res = await withSandbox({ source, exportName: 'routeAndPrice' }, (box) => box.run(inputs));
  if (!res.ok) return { ok: false, reasonCode: res.code, reason: res.reason };
  let goldenCost = 0;
  let freshCost = 0;
  for (let i = 0; i < scenarios.length; i += 1) {
    const kind = i < goldenCount ? 'golden' : 'fresh';
    const idx = i < goldenCount ? i : i - goldenCount;
    if (!res.results[i].ok) {
      return { ok: false, reasonCode: 'trapped', reason: `candidate threw on ${kind} scenario ${idx}` };
    }
    const check = ref.verifyDecision(scenarios[i], res.results[i].value);
    if (!check.ok) {
      return { ok: false, reasonCode: 'wrong_answer', reason: `${kind} scenario ${idx}: ${check.reason}` };
    }
    if (i < goldenCount) goldenCost += check.cost;
    else freshCost += check.cost;
  }
  return { ok: true, goldenCost, freshCost };
}

export function randomSeed() {
  return randomInt(1, 2 ** 31);
}

function buildSuite(scn, seed) {
  const golden = scn.buildScenarios(scn.GOLDEN_SEED);
  const fresh = scn.buildFreshScenarios(seed);
  return { golden, fresh, scenarios: [...golden, ...fresh] };
}

export async function verifyBusinessFiles({
  candidatePath,
  holderPath,
  referencePath,
  maxBytes = DEFAULT_MAX_BYTES,
  seed = randomSeed(),
}) {
  const raw = readFileSync(candidatePath, 'utf8');
  const guardError = guardCandidateSource(raw, maxBytes);
  if (guardError) return guardError;

  const loaded = await loadTargetModules(dirname(referencePath)).catch(() => null);
  if (!loaded) return rejected('fault', 'verifier could not load the target oracle');
  const { golden, fresh, scenarios } = buildSuite(loaded.scn, seed);
  const fuel = JSON.stringify({ golden: golden.length, fresh: fresh.length, seed });
  const suite = { scenarios, goldenCount: golden.length, ref: loaded.ref };

  const holderEval = await evaluateSuite({ ...suite, source: readFileSync(holderPath, 'utf8') });
  if (!holderEval.ok) {
    return rejected('fault', `holder baseline failed eval: ${holderEval.reason}`, { class_fuel: fuel });
  }
  const candEval = await evaluateSuite({ ...suite, source: raw });
  if (!candEval.ok) return rejected(candEval.reasonCode, candEval.reason, { class_fuel: fuel });

  const gain = (holderEval.goldenCost - candEval.goldenCost) / holderEval.goldenCost;
  const freshGain = (holderEval.freshCost - candEval.freshCost) / holderEval.freshCost;
  if (gain < MIN_IMPROVEMENT_RATIO || freshGain < MIN_IMPROVEMENT_RATIO) {
    return rejected(
      'bound_not_improved',
      `cost ${candEval.goldenCost} (fresh ${candEval.freshCost}) does not beat holder ${holderEval.goldenCost} (fresh ${holderEval.freshCost}) by at least 5% on both suites`,
      { metric_value: candEval.goldenCost, holder_value: holderEval.goldenCost, class_fuel: fuel },
    );
  }
  return {
    verdict: 'ACCEPTED',
    reason_code: '',
    reason: `passed ${golden.length} golden + ${fresh.length} fresh scenarios (seed ${seed}); golden cost ${candEval.goldenCost} < holder ${holderEval.goldenCost} (${(gain * 100).toFixed(1)}% cut, ${(freshGain * 100).toFixed(1)}% on fresh)`,
    resolution: 'improved',
    metric_value: candEval.goldenCost,
    holder_value: holderEval.goldenCost,
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
    const candPath = resolve(rootDir, target.file_path);
    const raw = readFileSync(candPath, 'utf8');
    const guardError = guardCandidateSource(raw, manifest.max_bytes ?? DEFAULT_MAX_BYTES);
    const fail = (reasonCode, reason) => {
      allOk = false;
      results.push({ target: target.name, ok: false, reason_code: reasonCode, reason });
    };
    if (guardError) {
      fail(guardError.reason_code, guardError.reason);
      continue;
    }
    const { ref, scn } = await loadTargetModules(resolve(rootDir, 'targets', target.name));
    const { golden, fresh, scenarios } = buildSuite(scn, seed);
    const evalRes = await evaluateSuite({ source: raw, scenarios, goldenCount: golden.length, ref });
    if (!evalRes.ok) {
      fail(evalRes.reasonCode, evalRes.reason);
      continue;
    }
    results.push({
      target: target.name,
      ok: true,
      scenarios: golden.length,
      fresh_scenarios: fresh.length,
      seed,
      eval_cost_units: evalRes.goldenCost,
    });
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
  const seed = flags.seed ? Number.parseInt(flags.seed, 10) : randomSeed();
  const verdict = await verifyBusinessFiles({
    candidatePath: resolve(flags.candidate),
    holderPath: flags.holder ? resolve(flags.holder) : resolve(rootDir, targetSpec.file_path),
    referencePath: resolve(rootDir, 'targets', targetSpec.name, 'reference.mjs'),
    maxBytes: manifest.max_bytes ?? DEFAULT_MAX_BYTES,
    seed,
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
