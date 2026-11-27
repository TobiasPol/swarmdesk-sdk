#!/usr/bin/env node
// Zero-dependency SQL equivalence + deterministic query-plan cost verifier using built-in node:sqlite.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

export const DEFAULT_MAX_BYTES = 32768;

const FORBIDDEN_SQL = [
  [/--/, 'SQL line comments are not allowed'],
  [/\/\*/, 'SQL block comments are not allowed'],
  [/;/, 'semicolons and multi-statement SQL are not allowed'],
  [/\bPRAGMA\b/i, 'PRAGMA is not allowed'],
  [/\bATTACH\b/i, 'ATTACH is not allowed'],
  [/\bDETACH\b/i, 'DETACH is not allowed'],
  [/\bINSERT\b/i, 'INSERT is not allowed'],
  [/\bUPDATE\b/i, 'UPDATE is not allowed'],
  [/\bDELETE\b/i, 'DELETE is not allowed'],
  [/\bDROP\b/i, 'DROP is not allowed'],
  [/\bALTER\b/i, 'ALTER is not allowed'],
  [/\bCREATE\b/i, 'CREATE is not allowed'],
  [/\bREPLACE\b/i, 'REPLACE is not allowed'],
  [/\bVACUUM\b/i, 'VACUUM is not allowed'],
  [/\bREINDEX\b/i, 'REINDEX is not allowed'],
  [/\bLOAD_EXTENSION\b/i, 'load_extension is not allowed'],
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

export function guardSql(rawText, maxBytes = DEFAULT_MAX_BYTES) {
  if (typeof rawText !== 'string' || rawText.trim().length === 0) {
    return rejected('schema_error', 'SQL file is empty');
  }
  if (Buffer.byteLength(rawText, 'utf8') > maxBytes) {
    return rejected('size_limit', `SQL file exceeds ${maxBytes} bytes`);
  }
  if (rawText.includes('\0') || rawText.charCodeAt(0) === 0xfeff) {
    return rejected('guard_rejected', 'SQL file contains invalid control bytes');
  }
  for (const [pattern, message] of FORBIDDEN_SQL) {
    if (pattern.test(rawText)) {
      return rejected('guard_rejected', message);
    }
  }
  if (!/^\s*(SELECT|WITH)\b/i.test(rawText)) {
    return rejected('guard_rejected', 'query must start with SELECT or WITH');
  }
  return null;
}

function seedFixture(db, variant) {
  const insCust = db.prepare('INSERT INTO customers (id, segment, is_active) VALUES (?, ?, ?)');
  const insOrd = db.prepare(
    'INSERT INTO orders (id, customer_id, month, gross_cents, status) VALUES (?, ?, ?, ?, ?)',
  );
  const insRef = db.prepare('INSERT INTO refunds (id, order_id, refund_cents) VALUES (?, ?, ?)');

  if (variant === 'empty') {
    insCust.run(1, 'enterprise', 1);
    return;
  }

  const segments = ['starter', 'growth', 'enterprise'];
  for (let c = 1; c <= 60; c += 1) {
    const active = variant === 'edge' && c % 5 === 0 ? 0 : c % 4 === 0 ? 0 : 1;
    insCust.run(c, segments[c % segments.length], active);
  }
  const months = ['2026-09', '2026-10', '2026-11'];
  let refId = 1;
  for (let o = 1; o <= 240; o += 1) {
    const cust = ((o * 7) % 60) + 1;
    const month = months[o % months.length];
    const status = o % 7 === 0 ? 'cancelled' : o % 9 === 0 ? 'pending' : 'paid';
    const gross = 1000 + ((o * 137) % 9000);
    insOrd.run(o, cust, month, gross, status);
    if (variant !== 'no-refunds' && o % 6 === 0) {
      insRef.run(refId++, o, 200 + (o % 300));
      if (o % 12 === 0) insRef.run(refId++, o, 150);
    }
  }
}

function hashRows(rows) {
  const canonical = JSON.stringify(rows);
  return createHash('sha256').update(canonical).digest('hex');
}

function measureQueryCost(db, sql) {
  const planRows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all();
  const vmRows = db.prepare(`EXPLAIN ${sql}`).all();
  let cost = vmRows.length;
  let scans = 0;
  let searches = 0;
  let correlated = 0;
  let tempBtree = 0;
  for (const row of planRows) {
    const detail = String(row.detail ?? '').toUpperCase();
    if (detail.includes('CORRELATED SCALAR SUBQUERY') || detail.includes('CORRELATED LIST SUBQUERY')) {
      correlated += 1;
      cost += 900;
    }
    if (/\bSCAN\b/.test(detail)) {
      scans += 1;
      cost += 500;
    }
    if (/\bSEARCH\b/.test(detail)) {
      searches += 1;
      cost += 20;
    }
    if (detail.includes('USE TEMP B-TREE')) {
      tempBtree += 1;
      cost += 100;
    }
  }
  return { cost, breakdown: { vm_opcodes: vmRows.length, scans, searches, correlated, temp_btree: tempBtree } };
}

function openSeededDb(schemaSql, variant) {
  const db = new DatabaseSync(':memory:');
  db.exec(schemaSql);
  seedFixture(db, variant);
  return db;
}

export function verifySqlFiles({ candidatePath, holderPath, referencePath, schemaPath, maxBytes = DEFAULT_MAX_BYTES }) {
  const candidateSql = readFileSync(candidatePath, 'utf8');
  const guardError = guardSql(candidateSql, maxBytes);
  if (guardError) return guardError;

  const schemaSql = readFileSync(schemaPath, 'utf8');
  const referenceSql = readFileSync(referencePath, 'utf8');
  const holderSql = readFileSync(holderPath, 'utf8');

  const variants = ['standard', 'no-refunds', 'edge', 'empty'];
  let candCost = null;
  let holderCost = null;
  let candBreakdown = {};

  for (const variant of variants) {
    const db = openSeededDb(schemaSql, variant);
    try {
      const expectedRows = db.prepare(referenceSql).all();
      let actualRows;
      try {
        actualRows = db.prepare(candidateSql).all();
      } catch (err) {
        return rejected('compile_error', `SQL failed: ${err instanceof Error ? err.message : 'error'}`);
      }
      if (hashRows(actualRows) !== hashRows(expectedRows)) {
        return rejected('wrong_answer', `result-set SHA-256 mismatch on ${variant} dataset`);
      }
      if (variant === 'standard') {
        const candMeasure = measureQueryCost(db, candidateSql);
        const holdMeasure = measureQueryCost(db, holderSql);
        candCost = candMeasure.cost;
        candBreakdown = candMeasure.breakdown;
        holderCost = holdMeasure.cost;
      }
    } finally {
      db.close();
    }
  }

  if (candCost >= holderCost) {
    return rejected(
      'bound_not_improved',
      `query plan cost ${candCost} does not beat holder ${holderCost}`,
      { metric_value: candCost, holder_value: holderCost },
    );
  }

  return {
    verdict: 'ACCEPTED',
    reason_code: '',
    reason: `exact SHA-256 match across ${variants.length} datasets; plan cost ${candCost} < holder ${holderCost}`,
    resolution: 'improved',
    metric_value: candCost,
    holder_value: holderCost,
    proof_lines: candidateSql.split('\n').length,
    wasm_bytes: 0,
    class_fuel: JSON.stringify(candBreakdown),
  };
}

export function verifySelfCheck(manifestPath) {
  const absManifest = resolve(manifestPath);
  const rootDir = dirname(absManifest);
  const manifest = JSON.parse(readFileSync(absManifest, 'utf8'));
  const results = [];
  let allOk = true;

  for (const target of manifest.targets ?? []) {
    const candPath = resolve(rootDir, target.file_path);
    const dir = resolve(rootDir, 'targets', target.name);
    const schemaSql = readFileSync(resolve(dir, 'schema.sql'), 'utf8');
    const refSql = readFileSync(resolve(dir, 'reference.sql'), 'utf8');
    const candSql = readFileSync(candPath, 'utf8');
    const guardError = guardSql(candSql, manifest.max_bytes ?? DEFAULT_MAX_BYTES);
    if (guardError) {
      allOk = false;
      results.push({ target: target.name, ok: false, reason_code: guardError.reason_code, reason: guardError.reason });
      continue;
    }
    const db = openSeededDb(schemaSql, 'standard');
    try {
      const exp = hashRows(db.prepare(refSql).all());
      const got = hashRows(db.prepare(candSql).all());
      if (exp !== got) {
        allOk = false;
        results.push({ target: target.name, ok: false, reason_code: 'wrong_answer', reason: 'baseline mismatch' });
        continue;
      }
      const { cost } = measureQueryCost(db, candSql);
      results.push({ target: target.name, ok: true, cost });
    } finally {
      db.close();
    }
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

function main(argv) {
  if (argv[0] === '--self-check') {
    const res = verifySelfCheck(argv[1] ?? 'targets.json');
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
    const dir = resolve(rootDir, 'targets', targetSpec.name);
    const verdict = verifySqlFiles({
      candidatePath: resolve(flags.candidate),
      holderPath: flags.holder ? resolve(flags.holder) : resolve(rootDir, targetSpec.file_path),
      referencePath: resolve(dir, 'reference.sql'),
      schemaPath: resolve(dir, 'schema.sql'),
      maxBytes: manifest.max_bytes ?? DEFAULT_MAX_BYTES,
    });
    if (flags.out) writeFileSync(flags.out, `${JSON.stringify(verdict)}\n`);
    console.log(JSON.stringify(verdict));
    process.exit(0);
  }
  console.error('usage: verify.mjs --self-check [targets.json] | verify --targets <targets.json> --target <name> --candidate <file> [--holder <file>] [--out <final.json>]');
  process.exit(2);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2));
}
