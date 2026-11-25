import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strassen2x2Z } from './fixtures.mjs';

const TENSOR_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'tensor-rank');

// The Swarmdesk CLI runs `scripts/check.sh <target>` and trusts its exit code, so the template
// must judge the working copy against the holder and exit 0 only on ACCEPTED.
function checkIn(dir, ...args) {
  return spawnSync('bash', ['scripts/check.sh', ...args], { cwd: dir, encoding: 'utf8' });
}

test('check.sh <target> judges the working copy like the deciding workflow', () => {
  // A copy outside any git repository: the target's baseline rank is the holder.
  const dir = join(mkdtempSync(join(tmpdir(), 'tensor-check-')), 'repo');
  try {
    cpSync(TENSOR_DIR, dir, { recursive: true });
    const unchanged = checkIn(dir, 'matmul_2x2_z');
    assert.equal(unchanged.status, 1);
    assert.equal(JSON.parse(unchanged.stdout).reason_code, 'bound_not_improved');

    writeFileSync(join(dir, 'targets', 'matmul_2x2_z.json'), JSON.stringify(strassen2x2Z()));
    const strassen = checkIn(dir, 'matmul_2x2_z');
    assert.equal(strassen.status, 0, strassen.stderr);
    assert.equal(JSON.parse(strassen.stdout).verdict, 'ACCEPTED');

    assert.equal(checkIn(dir, 'no_such_target').status, 2);
    assert.equal(checkIn(dir).status, 0);
  } finally {
    rmSync(dirname(dir), { recursive: true, force: true });
  }
});
