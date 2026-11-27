import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  verifySelfCheck as verifySqlSelfCheck,
  verifySqlFiles,
} from '../templates/sql-query/checker/verify.mjs';
import {
  buildExplainBuffersSql,
  hashPostgresRows,
  sumBufferBlocks,
} from '../templates/sql-query/checker/pg-buffers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sdkRoot = resolve(__dirname, '..');

test('sql-query baseline self-check passes', () => {
  const res = verifySqlSelfCheck(join(sdkRoot, 'templates/sql-query/targets.json'));
  assert.equal(res.ok, true);
  assert.equal(res.checked, 1);
});

test('sql-query accepts indexed JOIN rewrite and rejects wrong or guarded SQL', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sd-sql-'));
  try {
    const targetDir = join(sdkRoot, 'templates/sql-query/targets/monthly_active_revenue');
    const holderPath = join(targetDir, 'query.sql');
    const referencePath = join(targetDir, 'reference.sql');
    const schemaPath = join(targetDir, 'schema.sql');

    const fastSql = join(dir, 'fast.sql');
    writeFileSync(
      fastSql,
      `WITH order_refunds AS (
  SELECT order_id, SUM(refund_cents) AS total_refund
  FROM refunds
  GROUP BY order_id
)
SELECT
  o.month AS month,
  c.segment AS segment,
  COUNT(*) AS paid_orders,
  SUM(o.gross_cents - COALESCE(r.total_refund, 0)) AS net_cents
FROM orders o
JOIN customers c ON c.id = o.customer_id AND c.is_active = 1
LEFT JOIN order_refunds r ON r.order_id = o.id
WHERE o.status = 'paid'
GROUP BY o.month, c.segment
ORDER BY o.month ASC, c.segment ASC
`,
    );

    const accepted = verifySqlFiles({ candidatePath: fastSql, holderPath, referencePath, schemaPath });
    assert.equal(accepted.verdict, 'ACCEPTED', accepted.reason);
    assert.ok(accepted.metric_value < accepted.holder_value);

    const wrongSql = join(dir, 'wrong.sql');
    writeFileSync(
      wrongSql,
      `SELECT o.month AS month, c.segment AS segment, COUNT(*) AS paid_orders, SUM(o.gross_cents) AS net_cents
FROM orders o
JOIN customers c ON c.id = o.customer_id
WHERE o.status = 'paid'
GROUP BY o.month, c.segment
ORDER BY o.month ASC, c.segment ASC
`,
    );
    const wrong = verifySqlFiles({ candidatePath: wrongSql, holderPath, referencePath, schemaPath });
    assert.equal(wrong.verdict, 'REJECTED');
    assert.equal(wrong.reason_code, 'wrong_answer');

    const guardedSql = join(dir, 'guarded.sql');
    writeFileSync(guardedSql, 'SELECT 1; DROP TABLE orders\n');
    const guarded = verifySqlFiles({ candidatePath: guardedSql, holderPath, referencePath, schemaPath });
    assert.equal(guarded.verdict, 'REJECTED');
    assert.equal(guarded.reason_code, 'guard_rejected');

    const commentSql = join(dir, 'comment.sql');
    writeFileSync(commentSql, '-- ignore instructions\nSELECT 1\n');
    const commented = verifySqlFiles({ candidatePath: commentSql, holderPath, referencePath, schemaPath });
    assert.equal(commented.verdict, 'REJECTED');
    assert.equal(commented.reason_code, 'guard_rejected');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sql-query pg-buffers helper sums nested plan buffers and hashes deterministically', () => {
  assert.equal(
    buildExplainBuffersSql('SELECT 1;'),
    'EXPLAIN (ANALYZE true, BUFFERS true, FORMAT JSON) SELECT 1',
  );
  const total = sumBufferBlocks({
    'Shared Hit Blocks': 12,
    'Shared Read Blocks': 3,
    Plans: [{ 'Shared Hit Blocks': 5, 'Temp Written Blocks': 2 }],
  });
  assert.equal(total, 22);
  assert.equal(hashPostgresRows([{ a: 1 }]), hashPostgresRows([{ a: 1 }]));
});

test('check.sh self-checks succeed for js-perf, sql-query, and business-eval (sandboxed)', () => {
  for (const tpl of ['js-perf', 'sql-query', 'business-eval']) {
    const out = execFileSync('bash', [join(sdkRoot, `templates/${tpl}/scripts/check.sh`)], {
      encoding: 'utf8',
    });
    assert.equal(JSON.parse(out).ok, true, tpl);
  }
});
