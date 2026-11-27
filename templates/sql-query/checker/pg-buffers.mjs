/**
 * PostgreSQL Buffer-Read Adapter for customer SQL optimization sprints.
 * Wraps a candidate SELECT/WITH query inside a rolled-back READ ONLY transaction,
 * compares canonical SHA-256 result-set hashes against reference.sql, and extracts
 * deterministic `Shared Hit Blocks + Shared Read Blocks` from EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON).
 */
import { createHash } from 'node:crypto';

export function buildExplainBuffersSql(querySql) {
  const clean = querySql.trim().replace(/;+$/, '');
  return `EXPLAIN (ANALYZE true, BUFFERS true, FORMAT JSON) ${clean}`;
}

export function sumBufferBlocks(planRoot) {
  if (!planRoot || typeof planRoot !== 'object') return 0;
  let total =
    Number(planRoot['Shared Hit Blocks'] ?? 0) +
    Number(planRoot['Shared Read Blocks'] ?? 0) +
    Number(planRoot['Temp Read Blocks'] ?? 0) +
    Number(planRoot['Temp Written Blocks'] ?? 0);
  if (Array.isArray(planRoot.Plans)) {
    for (const child of planRoot.Plans) {
      total += sumBufferBlocks(child);
    }
  }
  return total;
}

export function hashPostgresRows(rows) {
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}
