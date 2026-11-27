// Parent side of the candidate sandbox: runs untrusted code in a separate Node process under the
// permission model and talks to it over stdin and a dedicated pipe (fd 3), never over its stdout.
// Everything the child sends back is untrusted data; callers must validate it.
import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Real paths only: the permission model compares resolved paths (macOS /var is a symlink).
const CHILD_PATH = realpathSync(join(dirname(fileURLToPath(import.meta.url)), 'child.mjs'));

export const SANDBOX_DEFAULTS = Object.freeze({
  timeoutMs: 20_000,
  maxOutputBytes: 32 * 1024 * 1024,
  maxOldSpaceMb: 256,
});

export function sandboxFlags(modulePath, maxOldSpaceMb) {
  return [
    '--permission',
    `--allow-fs-read=${CHILD_PATH}`,
    `--allow-fs-read=${modulePath}`,
    '--disallow-code-generation-from-strings',
    `--max-old-space-size=${maxOldSpaceMb}`,
  ];
}

function failure(code, reason) {
  return { ok: false, code, reason };
}

// Validates the wire shape only; the meaning of each value is up to the caller.
export function parseReply(line, expected) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return failure('trapped', 'candidate sent a malformed reply');
  }
  if (msg && typeof msg === 'object' && typeof msg.error === 'string') {
    return failure('compile_error', 'candidate module failed to load or lacks the required export');
  }
  if (!msg || !Array.isArray(msg.results) || msg.results.length !== expected) {
    return failure('trapped', 'candidate sent a malformed reply');
  }
  const results = msg.results.map((r) =>
    r && typeof r === 'object' && Object.hasOwn(r, 'v') ? { ok: true, value: r.v } : { ok: false },
  );
  return { ok: true, results };
}

// The permission model only denies the network by default in Node versions that know --allow-net.
export const sandboxSupported = () => process.allowedNodeEnvironmentFlags.has('--allow-net');

function spawnChild({ dir, modulePath, exportName, maxOldSpaceMb }) {
  const child = spawn(
    process.execPath,
    [...sandboxFlags(modulePath, maxOldSpaceMb), CHILD_PATH, modulePath, exportName],
    { stdio: ['pipe', 'ignore', 'ignore', 'pipe'], env: {}, cwd: dir },
  );
  child.stdin.on('error', () => {});
  const state = { exited: false, current: null };
  child.on('close', () => {
    state.exited = true;
    if (state.current) state.current.finish(failure('trapped', 'candidate process exited without a reply'));
  });
  child.on('error', () => {
    state.exited = true;
    if (state.current) state.current.finish(failure('fault', 'sandbox process could not be started'));
  });
  return { child, state };
}

// One request at a time. Resolves with {ok, results, elapsedNs} or {ok:false, code, reason}.
// elapsedNs runs from writing the request to receiving the last byte of the reply.
function request({ child, state }, limits, inputs, timeoutMs) {
  const payload = `${JSON.stringify({ inputs })}\n`;
  return new Promise((resolve) => {
    if (state.exited) return resolve(failure('trapped', 'candidate process is not running'));
    const chunks = [];
    let size = 0;
    let startedAt = 0n;
    const timer = setTimeout(
      () => finish(failure('timeout', `candidate exceeded the ${timeoutMs} ms wall-clock limit`)),
      timeoutMs,
    );
    const finish = (result) => {
      if (!state.current) return;
      state.current = null;
      clearTimeout(timer);
      child.stdio[3].off('data', onData);
      if (!result.ok) child.kill('SIGKILL');
      resolve(result);
    };
    const onData = (buf) => {
      size += buf.length;
      if (size > limits.maxOutputBytes) return finish(failure('size_limit', 'candidate output exceeds the size limit'));
      chunks.push(buf);
      if (buf.indexOf(10) === -1) return undefined;
      const elapsedNs = Number(process.hrtime.bigint() - startedAt);
      const parsed = parseReply(Buffer.concat(chunks).toString('utf8').split('\n', 1)[0], inputs.length);
      return finish(parsed.ok ? { ...parsed, elapsedNs } : parsed);
    };
    state.current = { finish };
    child.stdio[3].on('data', onData);
    startedAt = process.hrtime.bigint();
    child.stdin.write(payload);
    return undefined;
  });
}

export function startSandbox({ source, exportName, ...overrides }) {
  if (!sandboxSupported()) {
    const reason = 'this Node has no --allow-net permission flag; the sandbox cannot deny network access';
    return { run: async () => failure('fault', reason), close() {} };
  }
  const limits = { ...SANDBOX_DEFAULTS, ...overrides };
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'swarmdesk-sandbox-'));
  const modulePath = join(dir, 'module.mjs');
  writeFileSync(modulePath, source);
  const proc = spawnChild({ dir, modulePath, exportName, maxOldSpaceMb: limits.maxOldSpaceMb });
  return {
    run: (inputs, timeoutMs = limits.timeoutMs) => request(proc, limits, inputs, timeoutMs),
    close() {
      if (!proc.state.exited) proc.child.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function withSandbox(options, fn) {
  const box = startSandbox(options);
  try {
    return await fn(box);
  } finally {
    box.close();
  }
}
