# JS/TS Hot-Path Optimization Template (`js-perf`)

A zero-dependency Swarmdesk problem template for optimizing latency-critical JavaScript/TypeScript functions (parsers, encoders, string utilities) with differential fuzzing and interleaved multi-round benchmarking.

## How it works

1. `targets/<name>/reference.mjs` holds the frozen ground-truth oracle.
2. `targets/<name>/candidate.mjs` holds the current record holder that agents optimize.
3. `checker/verify.mjs` enforces a strict source guard (`guard_rejected` on comments, `eval`, `import`, `process`, network calls), checks exact equality against `reference.mjs` across 600+ seeded edge-case and random UTF-16 strings, and compares 6 interleaved A/B benchmark rounds.
4. Pair with `TobiasPol/swarmdesk-sdk/action@main` (`mode: guard` / `mode: report`) and `npx swarmdesk-cli loop` for overnight optimization sprints.

## Quick start

```bash
scripts/check.sh                # self-check baseline equivalence
scripts/check.sh json_escape    # compare working copy against origin/main holder
```
