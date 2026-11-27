#!/usr/bin/env node
// Zero-dependency deterministic business-rule, VAT compliance, and LLM cost-eval verifier.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_MAX_BYTES = 65536;
const MIN_IMPROVEMENT_RATIO = 0.05;

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
  if (!/export\s+function\s+routeAndPrice\s*\(/.test(rawText)) {
    return rejected('schema_error', 'candidate must export function routeAndPrice');
  }
  return null;
}

async function loadModule(filePath) {
  const url = `${pathToFileURL(resolve(filePath)).href}?t=${Date.now()}_${Math.random()}`;
  return import(url);
}

function evaluateSuite(fn, scenarios, verifyDecision) {
  let totalCost = 0;
  for (let i = 0; i < scenarios.length; i += 1) {
    let decision;
    try {
      decision = fn(scenarios[i]);
    } catch {
      return { ok: false, reasonCode: 'trapped', reason: `candidate threw on scenario ${i}` };
    }
    const check = verifyDecision(scenarios[i], decision);
    if (!check.ok) {
      return { ok: false, reasonCode: 'wrong_answer', reason: check.reason };
    }
    totalCost += check.cost;
  }
  return { ok: true, totalCost };
}

export async function verifyBusinessFiles({
  candidatePath,
  holderPath,
  referencePath,
  maxBytes = DEFAULT_MAX_BYTES,
}) {
  const raw = readFileSync(candidatePath, 'utf8');
  const guardError = guardCandidateSource(raw, maxBytes);
  if (guardError) return guardError;

  let refMod;
  let holderMod;
  let candMod;
  try {
    refMod = await loadModule(referencePath);
    holderMod = await loadModule(holderPath);
    candMod = await loadModule(candidatePath);
  } catch (err) {
    return rejected(
      'compile_error',
      `failed to load module: ${err instanceof Error ? err.message : 'unknown'}`,
    );
  }

  if (typeof candMod.routeAndPrice !== 'function' || typeof holderMod.routeAndPrice !== 'function') {
    return rejected('schema_error', 'modules must export routeAndPrice');
  }

  const scenarios = refMod.buildScenarios(20261127);
  const holderEval = evaluateSuite(holderMod.routeAndPrice, scenarios, refMod.verifyDecision);
  if (!holderEval.ok) {
    return rejected('fault', `holder baseline failed eval: ${holderEval.reason}`);
  }

  const candEval = evaluateSuite(candMod.routeAndPrice, scenarios, refMod.verifyDecision);
  if (!candEval.ok) {
    return rejected(candEval.reasonCode, candEval.reason);
  }

  const gain = (holderEval.totalCost - candEval.totalCost) / holderEval.totalCost;
  if (gain < MIN_IMPROVEMENT_RATIO) {
    return rejected(
      'bound_not_improved',
      `cost ${candEval.totalCost} does not beat holder ${holderEval.totalCost} by at least 5%`,
      { metric_value: candEval.totalCost, holder_value: holderEval.totalCost },
    );
  }

  return {
    verdict: 'ACCEPTED',
    reason_code: '',
    reason: `passed ${scenarios.length}/${scenarios.length} business & compliance evals; cost ${candEval.totalCost} < holder ${holderEval.totalCost} (${(gain * 100).toFixed(1)}% cut)`,
    resolution: 'improved',
    metric_value: candEval.totalCost,
    holder_value: holderEval.totalCost,
    proof_lines: raw.split('\n').length,
    wasm_bytes: 0,
    class_fuel: JSON.stringify({ scenarios: scenarios.length }),
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
    const refMod = await loadModule(refPath);
    const candMod = await loadModule(candPath);
    const scenarios = refMod.buildScenarios(20261127);
    const evalRes = evaluateSuite(candMod.routeAndPrice, scenarios, refMod.verifyDecision);
    if (!evalRes.ok) {
      allOk = false;
      results.push({ target: target.name, ok: false, reason_code: evalRes.reasonCode, reason: evalRes.reason });
      continue;
    }
    results.push({
      target: target.name,
      ok: true,
      scenarios: scenarios.length,
      eval_cost_units: evalRes.totalCost,
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
    const verdict = await verifyBusinessFiles({
      candidatePath: resolve(flags.candidate),
      holderPath: flags.holder ? resolve(flags.holder) : resolve(rootDir, targetSpec.file_path),
      referencePath: resolve(rootDir, 'targets', targetSpec.name, 'reference.mjs'),
      maxBytes: manifest.max_bytes ?? DEFAULT_MAX_BYTES,
    });
    if (flags.out) writeFileSync(flags.out, `${JSON.stringify(verdict)}\n`);
    console.log(JSON.stringify(verdict));
    process.exit(0);
  }
  console.error(
    'usage: verify.mjs --self-check [targets.json] | verify --targets <targets.json> --target <name> --candidate <file> [--holder <file>] [--out <final.json>]',
  );
  process.exit(2);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main(process.argv.slice(2));
}
