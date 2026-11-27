import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  verifyCandidateFiles,
  verifySelfCheck as verifyJsSelfCheck,
} from '../templates/js-perf/checker/verify.mjs';
import {
  verifySelfCheck as verifySqlSelfCheck,
  verifySqlFiles,
} from '../templates/sql-query/checker/verify.mjs';
import {
  buildExplainBuffersSql,
  hashPostgresRows,
  sumBufferBlocks,
} from '../templates/sql-query/checker/pg-buffers.mjs';
import {
  verifyBusinessFiles,
  verifySelfCheck as verifyBusinessSelfCheck,
} from '../templates/business-eval/checker/verify.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sdkRoot = resolve(__dirname, '..');

test('js-perf baseline self-check passes', async () => {
  const res = await verifyJsSelfCheck(join(sdkRoot, 'templates/js-perf/targets.json'));
  assert.equal(res.ok, true);
  assert.equal(res.checked, 1);
});

test('js-perf accepts fast slice-based escaper and rejects wrong or guarded code', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sd-jsperf-'));
  try {
    const holderPath = join(sdkRoot, 'templates/js-perf/targets/json_escape/candidate.mjs');
    const referencePath = join(sdkRoot, 'templates/js-perf/targets/json_escape/reference.mjs');

    const fastFile = join(dir, 'fast.mjs');
    writeFileSync(
      fastFile,
      `const ESC = /["\\\\\\x00-\\x1f]/;
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
`,
    );

    const accepted = await verifyCandidateFiles({ candidatePath: fastFile, holderPath, referencePath });
    assert.equal(accepted.verdict, 'ACCEPTED', accepted.reason);
    assert.ok(accepted.metric_value < accepted.holder_value);

    const wrongFile = join(dir, 'wrong.mjs');
    writeFileSync(wrongFile, 'export function jsonEscape(str) { return `"${str}"`; }\n');
    const wrong = await verifyCandidateFiles({ candidatePath: wrongFile, holderPath, referencePath });
    assert.equal(wrong.verdict, 'REJECTED');
    assert.equal(wrong.reason_code, 'wrong_answer');

    const guardedFile = join(dir, 'guarded.mjs');
    writeFileSync(guardedFile, '// sneaky comment\nexport function jsonEscape(s) { return s; }\n');
    const guarded = await verifyCandidateFiles({ candidatePath: guardedFile, holderPath, referencePath });
    assert.equal(guarded.verdict, 'REJECTED');
    assert.equal(guarded.reason_code, 'guard_rejected');

    const unchanged = await verifyCandidateFiles({ candidatePath: holderPath, holderPath, referencePath });
    assert.equal(unchanged.verdict, 'REJECTED');
    assert.equal(unchanged.reason_code, 'bound_not_improved');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

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

test('check.sh self-checks succeed for js-perf, sql-query, and business-eval', () => {
  for (const tpl of ['js-perf', 'sql-query', 'business-eval']) {
    const out = execFileSync('bash', [join(sdkRoot, `templates/${tpl}/scripts/check.sh`)], {
      encoding: 'utf8',
    });
    assert.equal(JSON.parse(out).ok, true, tpl);
  }
});

test('business-eval baseline self-check passes', async () => {
  const res = await verifyBusinessSelfCheck(join(sdkRoot, 'templates/business-eval/targets.json'));
  assert.equal(res.ok, true);
  assert.equal(res.checked, 1);
  assert.equal(res.results[0].scenarios, 240);
});

test('business-eval accepts tier-aware router and rejects wrong VAT or guarded code', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sd-bizeval-'));
  try {
    const targetDir = join(sdkRoot, 'templates/business-eval/targets/pricing_router');
    const holderPath = join(targetDir, 'candidate.mjs');
    const referencePath = join(targetDir, 'reference.mjs');

    const optimalFile = join(dir, 'optimal.mjs');
    writeFileSync(
      optimalFile,
      `export function routeAndPrice(s) {
  const annualPct = s.annualBilling && s.seats >= 5 ? 15 : 0;
  const volumeFloor = s.seats >= 100 ? 20 : 0;
  const discountPct = Math.max(volumeFloor, annualPct, s.couponPct);
  const netCents = Math.round((s.seats * s.planCents * (100 - discountPct)) / 100);
  let taxMode = 'NON_EU_EXPORT';
  let vatCents = 0;
  if (s.customerCountry === 'DE') {
    taxMode = 'DE_19';
    vatCents = Math.round((netCents * 19) / 100);
  } else if (s.customerCountry === 'FR' || s.customerCountry === 'NL') {
    if (s.hasValidVatId) {
      taxMode = 'EU_REVERSE_CHARGE';
    } else {
      taxMode = 'EU_VAT_19';
      vatCents = Math.round((netCents * 19) / 100);
    }
  }
  let model = s.taskTier === 'audit' ? 'frontier' : s.taskTier === 'synthesize' ? 'mid' : 'mini';
  if (model === 'mini' && s.requiresJsonSchema && s.inputTokens > 2500) {
    model = 'mid';
  }
  return { netCents, vatCents, totalCents: netCents + vatCents, taxMode, model };
}
`,
    );

    const accepted = await verifyBusinessFiles({
      candidatePath: optimalFile,
      holderPath,
      referencePath,
    });
    assert.equal(accepted.verdict, 'ACCEPTED', accepted.reason);
    assert.ok(accepted.metric_value < accepted.holder_value * 0.7);

    const wrongFile = join(dir, 'wrong.mjs');
    writeFileSync(
      wrongFile,
      'export function routeAndPrice(s) { return { netCents: 0, vatCents: 0, totalCents: 0, taxMode: "DE_19", model: "mini" }; }\n',
    );
    const wrong = await verifyBusinessFiles({ candidatePath: wrongFile, holderPath, referencePath });
    assert.equal(wrong.verdict, 'REJECTED');
    assert.equal(wrong.reason_code, 'wrong_answer');

    const guardedFile = join(dir, 'guarded.mjs');
    writeFileSync(
      guardedFile,
      'import { readFileSync } from "node:fs";\nexport function routeAndPrice() { return {}; }\n',
    );
    const guarded = await verifyBusinessFiles({
      candidatePath: guardedFile,
      holderPath,
      referencePath,
    });
    assert.equal(guarded.verdict, 'REJECTED');
    assert.equal(guarded.reason_code, 'guard_rejected');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
