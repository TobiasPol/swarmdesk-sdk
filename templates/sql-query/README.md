# SQL Query Optimization Template (`sql-query`)

A zero-dependency Swarmdesk problem template for optimizing read-only SQL queries using Node's built-in `node:sqlite`, deterministic query-plan scoring, and exact SHA-256 result-set equivalence verification.

## How it works

1. `targets/<name>/schema.sql` sets up deterministic tables and indexes.
2. `targets/<name>/reference.sql` is the frozen oracle query.
3. `targets/<name>/query.sql` is the holder file optimized by agents.
4. `checker/verify.mjs` blocks SQL comments, multi-statement queries, and write/PRAGMA commands (`guard_rejected`), checks exact SHA-256 row equivalence across 4 seeded datasets (`standard`, `no-refunds`, `edge`, `empty`), and measures deterministic query-plan cost (`EXPLAIN` + `EXPLAIN QUERY PLAN`).
5. `checker/pg-buffers.mjs` provides a drop-in adapter for PostgreSQL sprints using `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`.

## Quick start

```bash
scripts/check.sh                          # self-check baseline equivalence
scripts/check.sh monthly_active_revenue   # compare working copy against origin/main holder
```
