import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { CHEATS, HONEST } from './business-fixtures.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'sd-checksh-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

const git = (cwd, ...args) =>
  spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });

// A copy of the template inside a throwaway git repo whose origin/main holds the baseline holder.
function workingCopy(name, template = 'business-eval') {
  const dir = join(tmp, name);
  cpSync(join(root, 'templates', template), dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'baseline');
  git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  return dir;
}

const check = (dir, ...args) => spawnSync('bash', ['scripts/check.sh', ...args], { cwd: dir, encoding: 'utf8' });
const CANDIDATE = 'targets/pricing_router/candidate.mjs';

test('check.sh exits 0 and prints the verdict for an honest improvement', () => {
  const dir = workingCopy('honest');
  writeFileSync(join(dir, CANDIDATE), HONEST);
  const res = check(dir, 'pricing_router');
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.equal(JSON.parse(res.stdout).verdict, 'ACCEPTED');
});

test('check.sh fails on a candidate that prints a forged ACCEPTED line and exits 0', () => {
  const dir = workingCopy('forge');
  writeFileSync(join(dir, CANDIDATE), CHEATS.D_forge);
  const res = check(dir, 'pricing_router');
  assert.notEqual(res.status, 0);
  assert.ok(!res.stdout.includes('"verdict":"ACCEPTED"'), res.stdout);
  assert.equal(JSON.parse(res.stdout).verdict, 'REJECTED');
});

test('check.sh reads the verdict from the --out file, never from stdout', () => {
  const stub = (stdoutVerdict, fileVerdict) => `import { writeFileSync } from 'node:fs';
const out = process.argv[process.argv.indexOf('--out') + 1];
${fileVerdict ? `writeFileSync(out, JSON.stringify({ verdict: '${fileVerdict}' }) + '\\n');` : ''}
console.log(JSON.stringify({ verdict: '${stdoutVerdict}' }));
`;
  const cases = [
    ['ACCEPTED', 'REJECTED', 1],
    ['REJECTED', 'ACCEPTED', 0],
    ['ACCEPTED', '', 1],
  ];
  cases.forEach(([onStdout, inFile, status], i) => {
    const dir = workingCopy(`stub${i}`);
    writeFileSync(join(dir, 'checker/verify.mjs'), stub(onStdout, inFile));
    const res = check(dir, 'pricing_router');
    assert.equal(res.status, status, `stdout=${onStdout} file=${inFile || 'none'}: ${res.stdout}${res.stderr}`);
  });
});

test('check.sh fails closed when the verifier crashes', () => {
  const dir = workingCopy('crash');
  writeFileSync(join(dir, 'checker/verify.mjs'), 'process.exit(3);\n');
  assert.notEqual(check(dir, 'pricing_router').status, 0);
});

test('every template check.sh reads the verdict from --out (js-perf, sql-query, business-eval)', () => {
  for (const template of ['js-perf', 'sql-query', 'business-eval']) {
    const dir = workingCopy(`all-${template}`, template);
    const target = template === 'js-perf' ? 'json_escape' : template === 'sql-query' ? 'monthly_active_revenue' : 'pricing_router';
    const res = check(dir, target);
    assert.equal(res.status, 1, `${template}: an unchanged holder is not an improvement`);
    assert.equal(JSON.parse(res.stdout).reason_code, 'bound_not_improved', template);
  }
});
