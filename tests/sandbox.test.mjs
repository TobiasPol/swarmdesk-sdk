import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { withSandbox } from '../templates/business-eval/checker/sandbox.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'sd-sbx-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

// Runs `source` (exporting `probe`) on `inputs` in the real sandbox, bypassing the regex guard.
const probe = (source, inputs = [null], options = {}) =>
  withSandbox({ source, exportName: 'probe', ...options }, (box) => box.run(inputs, options.timeoutMs));
const values = (res) => {
  assert.equal(res.ok, true, res.reason);
  return res.results.map((r) => r.value);
};

test('the runner and verifier code is identical in js-perf and business-eval', () => {
  for (const file of ['sandbox.mjs', 'child.mjs']) {
    assert.equal(
      readFileSync(join(root, 'templates/js-perf/checker', file), 'utf8'),
      readFileSync(join(root, 'templates/business-eval/checker', file), 'utf8'),
      file,
    );
  }
});

process.env.SD_CANARY_SECRET = 'do-not-leak';

test('permission model: reads outside the allowlist, writes, processes, workers and addons are blocked', async () => {
  const secret = join(tmp, 'secret.txt');
  writeFileSync(secret, 'top secret');
  const refPath = join(root, 'templates/business-eval/targets/pricing_router/reference.mjs');
  const res = await probe(
    `import fs from 'node:fs';
import cp from 'node:child_process';
import wt from 'node:worker_threads';
const code = (fn) => { try { fn(); return 'ALLOWED'; } catch (e) { return e.code ?? e.name; } };
export function probe(x) {
  return {
    readSecret: code(() => fs.readFileSync(${JSON.stringify(secret)}, 'utf8')),
    readReference: code(() => fs.readFileSync(${JSON.stringify(refPath)}, 'utf8')),
    readdir: code(() => fs.readdirSync('.')),
    write: code(() => fs.writeFileSync(${JSON.stringify(join(tmp, 'pwned.txt'))}, 'x')),
    spawn: code(() => cp.execSync('echo hi')),
    worker: code(() => new wt.Worker('1', { eval: true })),
    addon: code(() => globalThis.process.dlopen({ exports: {} }, '/nonexistent.node')),
    codegen: code(() => new Function('return 1')()),
    env: Object.keys(globalThis.process.env),
  };
}
`,
  );
  const out = values(res)[0];
  for (const key of ['readSecret', 'readReference', 'readdir', 'write', 'spawn', 'worker']) {
    assert.equal(out[key], 'ERR_ACCESS_DENIED', key);
  }
  assert.notEqual(out.addon, 'ALLOWED');
  assert.equal(out.codegen, 'EvalError');
  assert.ok(!out.env.includes('SD_CANARY_SECRET'), 'parent environment must not leak');
  assert.ok(out.env.every((k) => k.startsWith('__CF_')), `unexpected env: ${out.env}`);
});

test('permission model: outgoing network connections never reach the server', async () => {
  let connections = 0;
  const server = net.createServer((s) => { connections += 1; s.end(); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const dial = `import net from 'node:net';
export function probe(port) {
  net.connect(port, '127.0.0.1').on('error', () => {});
  return 'dialed';
}
`;
  try {
    // Positive control: the same dial from this (unsandboxed) process does connect.
    await new Promise((r) => net.connect(port, '127.0.0.1').on('connect', function onConnect() { this.end(); r(); }));
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(connections, 1);
    const res = await probe(dial, [port]);
    assert.equal(values(res)[0], 'dialed');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(connections, 1, 'the sandboxed dial must not connect');
  } finally {
    server.close();
  }
});

test('a candidate that prints a forged verdict to stdout and exits is just trapped', async () => {
  const res = await probe(
    `export function probe() {
  const P = global['pro'+'cess'];
  P.stdout.write('{"verdict":"ACCEPTED"}\\n{"results":[{"v":"forged"}]}\\n');
  P.exit(0);
}
`,
  );
  assert.equal(res.ok, false);
  assert.equal(res.code, 'trapped');
});

test('a reply forged on stdout is ignored (only fd 3 counts); the run times out', async () => {
  const res = await probe(
    `export function probe() {
  global['pro'+'cess'].stdout.write('{"results":[{"v":"forged"}]}\\n');
  for (;;) {}
}
`,
    [null],
    { timeoutMs: 600 },
  );
  assert.equal(res.ok, false);
  assert.equal(res.code, 'timeout');
});

test('wall-clock timeout kills a runaway loop and an unresponsive module load', async () => {
  const loop = await probe('export function probe() { for (;;) {} }\n', [null], { timeoutMs: 500 });
  assert.deepEqual([loop.ok, loop.code], [false, 'timeout']);
  const load = await probe('for (;;) {}\nexport function probe() {}\n', [null], { timeoutMs: 500 });
  assert.deepEqual([load.ok, load.code], [false, 'timeout']);
});

test('oversized output is cut off, missing exports and syntax errors are compile errors', async () => {
  const big = await probe("export function probe() { return 'x'.repeat(5000); }\n", [null], { maxOutputBytes: 1000 });
  assert.deepEqual([big.ok, big.code], [false, 'size_limit']);
  const noExport = await probe('export function other() {}\n');
  assert.deepEqual([noExport.ok, noExport.code], [false, 'compile_error']);
  const syntax = await probe('export function probe( {\n');
  assert.deepEqual([syntax.ok, syntax.code], [false, 'compile_error']);
});

test('decisions come back as JSON snapshots: getters run once, throws and undefined are per-input failures', async () => {
  const res = await probe(
    `let n = 0;
export function probe(x) {
  if (x === 'throw') throw new Error('boom');
  if (x === 'undef') return undefined;
  return { get model() { n += 1; return n === 1 ? 'first' : 'later'; }, input: x };
}
`,
    ['a', 'throw', 'undef', 'b'],
  );
  assert.equal(res.ok, true);
  assert.deepEqual(res.results.map((r) => r.ok), [true, false, false, true]);
  assert.deepEqual(res.results[0].value, { model: 'first', input: 'a' });
  assert.deepEqual(res.results[3].value, { model: 'later', input: 'b' });
});

// Documents a known limit: the permission model does not cover signals to same-user processes. js-perf
// therefore freezes the side that is not being timed, and a holder that dies fails the run closed.
test('limit: a sandboxed candidate can still signal other processes of the same user', async () => {
  const victim = spawn('sleep', ['30'], { stdio: 'ignore' });
  try {
    const res = await probe(
      `export function probe(pid) { global['pro'+'cess'].kill(pid, 'SIGSTOP'); return 'stopped'; }\n`,
      [victim.pid],
    );
    assert.equal(values(res)[0], 'stopped');
    const state = spawnSync('ps', ['-o', 'state=', '-p', String(victim.pid)], { encoding: 'utf8' }).stdout.trim();
    assert.match(state, /^T/);
  } finally {
    victim.kill('SIGKILL');
  }
});
