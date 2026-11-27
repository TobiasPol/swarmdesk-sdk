import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { verifyCandidateFiles, verifySelfCheck } from '../templates/js-perf/checker/verify.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const jsPerf = join(root, 'templates/js-perf');
const manifestPath = join(jsPerf, 'targets.json');
const holderPath = join(jsPerf, 'targets/parse_range/candidate.mjs');
const HOLDER = readFileSync(holderPath, 'utf8');
const tmp = mkdtempSync(join(tmpdir(), 'sd-jsperf-targets-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

const judgeRange = (name, source, seed = 7654321) => {
  const candidatePath = join(tmp, `${name}.mjs`);
  writeFileSync(candidatePath, source);
  return verifyCandidateFiles({ candidatePath, holderPath, manifestPath, targetName: 'parse_range', seed });
};

test('a target with two spread arguments and object outputs rejects a candidate that skips merging', async () => {
  const noMerge = HOLDER.replace('if (next.start <= top.end + 1)', 'if (false)');
  const v = await judgeRange('no-merge', noMerge);
  assert.deepEqual([v.verdict, v.reason_code], ['REJECTED', 'wrong_answer'], v.reason);
});

test('the guard asks for the export named in targets.json, not jsonEscape', async () => {
  const v = await judgeRange('wrong-export', 'export function jsonEscape(s) { return s; }\n');
  assert.deepEqual([v.verdict, v.reason_code], ['REJECTED', 'schema_error']);
  assert.match(v.reason, /parseRange/);
});

test('memoizing on the header string earns nothing on parse_range: no input repeats', async () => {
  const memo = HOLDER.replace('export function parseRange(size, header) {', 'const cache = new Map();\nfunction slow(size, header) {')
    .concat('export function parseRange(size, header) {\n  const k = size + "|" + header;\n  let r = cache.get(k);\n  if (r === undefined) { r = slow(size, header); cache.set(k, r); }\n  return r;\n}\n');
  const v = await judgeRange('memo', memo);
  assert.deepEqual([v.verdict, v.reason_code], ['REJECTED', 'bound_not_improved'], v.reason);
});

// A throwaway problem whose reference throws for negative input, returns undefined for zero and an
// object otherwise, so every outcome kind is exercised.
function scratchProblem(candidates) {
  const dir = mkdtempSync(join(tmp, 'problem-'));
  mkdirSync(join(dir, 'targets/f'), { recursive: true });
  writeFileSync(
    join(dir, 'targets/f/reference.mjs'),
    'export function f(x) { if (x < 0) throw new Error("neg"); if (x === 0) return undefined; return { a: x, b: x * 2 }; }\n',
  );
  writeFileSync(
    join(dir, 'targets/f/dataset.mjs'),
    'export function golden() { return [-3, -1, 0, 1, 2, 7]; }\nexport function fresh(seed, size = 50) { return Array.from({ length: size }, (_, i) => ((seed + i) % 11) - 5); }\n',
  );
  const targets = Object.entries(candidates).map(([name, source]) => {
    writeFileSync(join(dir, `targets/f/${name}.mjs`), source);
    return { name: 'f', file_path: `targets/f/${name}.mjs`, export: 'f', args: 'single' };
  });
  writeFileSync(join(dir, 'targets.json'), JSON.stringify({ problem: 'scratch', targets }));
  return join(dir, 'targets.json');
}

test('outcomes must match exactly: throws, undefined and the JSON text of values (key order included)', async () => {
  const manifest = scratchProblem({
    same: 'export function f(x) { if (x < 0) throw new Error("other message"); if (x === 0) return undefined; return { a: x, b: x * 2 }; }\n',
    undefinedForThrow: 'export function f(x) { if (x <= 0) return undefined; return { a: x, b: x * 2 }; }\n',
    throwForUndefined: 'export function f(x) { if (x <= 0) throw new Error("x"); return { a: x, b: x * 2 }; }\n',
    keyOrder: 'export function f(x) { if (x < 0) throw new Error("x"); if (x === 0) return undefined; return { b: x * 2, a: x }; }\n',
  });
  const res = await verifySelfCheck(manifest, { seed: 99 });
  const codes = res.results.map((r) => (r.ok ? 'ok' : r.reason_code));
  assert.deepEqual(codes, ['ok', 'wrong_answer', 'trapped', 'wrong_answer']);
});
