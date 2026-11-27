# SQL Query Optimization Template (`sql-query`)

A zero-dependency Swarmdesk problem template for optimizing read-only SQL queries using Node's built-in `node:sqlite`, a deterministic SQLite query-plan cost heuristic, and exact SHA-256 result-set equivalence verification.

## How it works

1. `targets/<name>/schema.sql` sets up deterministic tables and indexes.
2. `targets/<name>/reference.sql` is the frozen oracle query.
3. `targets/<name>/query.sql` is the holder file optimized by agents.
4. `checker/verify.mjs` blocks SQL comments, multi-statement queries, and write/PRAGMA commands (`guard_rejected`), checks exact SHA-256 row equivalence across 4 seeded datasets (`standard`, `no-refunds`, `edge`, `empty`), and scores the query with the cost heuristic below.

## What the metric is (and is not)

The metric (`query_plan_cost`) is a **heuristic over SQLite's `EXPLAIN` output**, computed by `measureQueryCost` in `checker/verify.mjs`. It is not measured runtime, I/O, or a PostgreSQL buffer count:

| Component | Cost |
| --- | --- |
| VDBE opcodes in `EXPLAIN` | 1 each |
| `SCAN` in `EXPLAIN QUERY PLAN` (full table scan) | +500 |
| correlated scalar/list subquery | +900 |
| `SEARCH` (index lookup) | +20 |
| `USE TEMP B-TREE` | +100 |

Because the weights are fixed, a rewrite that removes scans and correlated subqueries scores lower, but the number says nothing about wall-clock time on a real database. Result equivalence, by contrast, is exact: the candidate's rows are hashed and compared with the reference on every dataset.

## Isolation

No process sandbox is needed because the candidate is SQL, not code. `node:sqlite` is used with an in-memory database and extension loading is off by default (verified on Node 26: `load_extension()` fails with `not authorized` and `DatabaseSync#loadExtension` throws `extension loading is not allowed`). The checker additionally rejects comments, semicolons, `PRAGMA`, `ATTACH`/`DETACH`, DDL/DML keywords and `load_extension` before preparing the statement, and only one `SELECT`/`WITH` statement is ever prepared. The verdict is still computed and written by the parent process; `scripts/check.sh` reads it from the `--out` file.

## `checker/pg-buffers.mjs` is not wired in

`checker/pg-buffers.mjs` is an optional helper for people who want to run a Postgres sprint by hand (`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` builder, buffer-block summing, row hashing). **`checker/verify.mjs` does not import or call it**, nothing in `targets.json` or the CI uses it for judging, and it is only unit-tested on canned plan JSON. Wiring it in would need a live PostgreSQL server, which this zero-dependency template does not assume.

## Quick start

```bash
scripts/check.sh                          # self-check baseline equivalence
scripts/check.sh monthly_active_revenue   # compare working copy against origin/main holder
```
