# Business & Compliance Eval Optimization Template (`business-eval`)

A zero-dependency Swarmdesk problem template proving **business and technical** optimizations deterministically: optimize LLM model-routing spend or checkout pricing logic without ever violating billing, VAT compliance, or quality SLA floors.

## How it works

1. `targets/<name>/reference.mjs` freezes 240 deterministic checkout/VAT/SLA scenarios and the compliance oracle (`verifyDecision`, `scoreScenarioCost`).
2. `targets/<name>/candidate.mjs` holds the current record holder (baseline passes 100% of billing and EU VAT rules while over-provisioning the frontier model tier).
3. `checker/verify.mjs` enforces a strict source guard (`guard_rejected` on comments, `eval`, `import`, `process`, network calls), checks 100% accuracy across all 240 golden scenarios, and verifies strictly lower integer `eval_cost_units`.

## Quick start

```bash
scripts/check.sh                   # self-check baseline compliance & eval suite
scripts/check.sh pricing_router    # compare working copy against origin/main holder
```
