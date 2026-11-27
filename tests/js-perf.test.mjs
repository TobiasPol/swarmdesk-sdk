import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { deriveSeed } from '../templates/js-perf/checker/dataset.mjs';
import { fresh as buildFreshDataset } from '../templates/js-perf/targets/json_escape/dataset.mjs';
import { verifyCandidateFiles, verifySelfCheck } from '../templates/js-perf/checker/verify.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'templates/js-perf/targets/json_escape');
const holderPath = join(target, 'candidate.mjs');
const manifestPath = join(root, 'templates/js-perf/targets.json');
const tmp = mkdtempSync(join(tmpdir(), 'sd-jsperf-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

const FAST = `const ESC = /["\\\\\\x00-\\x1f]/;
const HEX = Array.from({ length: 32 }, (_, c) => '\\\\u' + c.toString(16).padStart(4, '0'));
HEX[8] = '\\\\b'; HEX[9] = '\\\\t'; HEX[10] = '\\\\n'; HEX[12] = '\\\\f'; HEX[13] = '\\\\r';
export function jsonEscape(str) {
  if (!ESC.test(str)) return '"' + str + '"';
  let out = '"';
  let last = 0;
  for (let i = 0; i < str.length; i += 1) {
    const c = str.charCodeAt(i);
    if (c === 34 || c === 92 || c < 32) {
      if (last !== i) out += str.slice(last, i);
      out += c === 34 ? '\\\\"' : c === 92 ? '\\\\\\\\' : HEX[c];
      last = i + 1;
    }
  }
  if (last !== str.length) out += str.slice(last);
  return out + '"';
}
`;
const HOLDER = `${await import('node:fs').then((fs) => fs.readFileSync(holderPath, 'utf8'))}`;

const judge = (name, source, seed = 1234567) => {
  const candidatePath = join(tmp, `${name}.mjs`);
  writeFileSync(candidatePath, source);
  return verifyCandidateFiles({ candidatePath, holderPath, manifestPath, targetName: 'json_escape', seed });
};

test('js-perf baseline self-check passes (inside the sandbox)', async () => {
  const res = await verifySelfCheck(join(root, 'templates/js-perf/targets.json'));
  assert.equal(res.ok, true, JSON.stringify(res.results));
  assert.equal(res.checked, 2);
  assert.equal(res.results[0].samples, 607);
  assert.equal(res.results[1].samples, 422);
});

test('js-perf accepts a faster escaper and records the seed', async () => {
  const v = await judge('fast', FAST);
  assert.equal(v.verdict, 'ACCEPTED', v.reason);
  assert.ok(v.metric_value < v.holder_value);
  assert.equal(JSON.parse(v.class_fuel).seed, 1234567);
});

test('js-perf rejects wrong, guarded and unchanged code', async () => {
  const wrong = await judge('wrong', 'export function jsonEscape(str) { return `"${str}"`; }\n');
  assert.deepEqual([wrong.verdict, wrong.reason_code], ['REJECTED', 'wrong_answer']);
  const guarded = await judge('guarded', '// sneaky comment\nexport function jsonEscape(s) { return s; }\n');
  assert.deepEqual([guarded.verdict, guarded.reason_code], ['REJECTED', 'guard_rejected']);
  const unchanged = await judge('unchanged', HOLDER);
  assert.deepEqual([unchanged.verdict, unchanged.reason_code], ['REJECTED', 'bound_not_improved']);
});

test('memoizing the input (before: ACCEPTED at a 99.2% cut) is REJECTED because no input repeats', async () => {
  const memo = HOLDER.replace('export function jsonEscape(str) {', 'const cache = new Map();\nfunction slow(str) {')
    .concat('export function jsonEscape(str) {\n  let r = cache.get(str);\n  if (r === undefined) { r = slow(str); cache.set(str, r); }\n  return r;\n}\n');
  const v = await judge('memo', memo);
  assert.deepEqual([v.verdict, v.reason_code], ['REJECTED', 'bound_not_improved'], v.reason);
});

test('correct on the public golden inputs but wrong on fresh ones is REJECTED', async () => {
  const lookalike = HOLDER.replace('export function jsonEscape(str) {', "export function jsonEscape(str) {\n  if (str.includes('😀')) return '\"?\"';");
  const v = await judge('fresh-only', lookalike);
  assert.deepEqual([v.verdict, v.reason_code], ['REJECTED', 'wrong_answer']);
  assert.match(v.reason, /fresh/);
});

test('tampering with the child clock cannot help: timing is taken by the parent', async () => {
  const clock = `const P = global['pro'+'cess'];
let t = 0n;
P.hrtime.bigint = () => (t += 1n);
${HOLDER}`;
  const v = await judge('clock', clock);
  assert.deepEqual([v.verdict, v.reason_code], ['REJECTED', 'bound_not_improved'], v.reason);
});

test('forging a verdict on stdout from a js-perf candidate does nothing', async () => {
  const forged = `export function jsonEscape(s) {
  const P = global['pro'+'cess'];
  P.stdout.write('{"verdict":"ACCEPTED"}\\n');
  P.exit(0);
}
`;
  const v = await judge('forge', forged);
  assert.deepEqual([v.verdict, v.reason_code], ['REJECTED', 'trapped']);
});

test('benchmark inputs are fresh: round seeds are independent and no dataset repeats', () => {
  const seeds = new Set();
  for (let p = 0; p < 4; p += 1) for (let r = 0; r < 9; r += 1) seeds.add(deriveSeed(987654321012, 'round', p, r));
  assert.equal(seeds.size, 36);
  assert.notEqual(deriveSeed(1, 'round', 0, 0), deriveSeed(2, 'round', 0, 0));
  const a = buildFreshDataset(deriveSeed(5, 'round', 0, 0), 400);
  const b = buildFreshDataset(deriveSeed(5, 'round', 0, 1), 400);
  assert.equal(a.filter((s) => s.length > 20 && b.includes(s)).length, 0);
  assert.deepEqual(a, buildFreshDataset(deriveSeed(5, 'round', 0, 0), 400));
});
