# Business & Compliance Eval Optimization Template (`business-eval`)

A zero-dependency Swarmdesk problem template proving **business and technical** optimizations deterministically: optimize LLM model-routing spend or checkout pricing logic without ever violating billing, VAT compliance, or quality SLA floors.

## How it works

1. `targets/<name>/reference.mjs` is the oracle: discount rules, VAT treatment and the quality SLA (`verifyDecision`, `scoreScenarioCost`). It runs only in the verifier process.
2. `targets/<name>/scenarios.mjs` generates the inputs: 240 **golden** scenarios (fixed seed `20261127`, public) and 2,184 **fresh** scenarios per run from a random seed that is recorded in the verdict (`class_fuel.seed`, reproduce with `--seed <n>`). Fresh scenarios cover every supported country with and without a VAT ID at seats 1/4/5/99/100/101, annual billing on/off and coupons 0/100, plus a sweep of every seat count 1..300 and every coupon 0..100, plus 300 random rows. Plan prices, tiers and token counts are random, and the candidate never sees a scenario id.
3. `targets/<name>/candidate.mjs` holds the current record holder (correct billing and VAT, but always the `frontier` model).
4. `checker/verify.mjs` guards the source, runs holder and candidate in the sandbox below on golden + fresh scenarios, validates every decision (exact fields, integer cents, known `taxMode`/`model`) and requires 100% agreement with the oracle. The metric is the golden-suite model cost (`eval_cost_units`); the candidate must also beat the holder by at least 5% on the fresh suite, so a table memorizing the public golden inputs gains nothing.

The scenarios cover 9 rules: 3 discount rules (annual billing from 5 seats 15%, volume 20% from 100 seats, coupon; the largest applies), 4 VAT modes and 2 SLA rules (tier quality floor, escalation to `mid` for JSON-schema tasks above 2,500 tokens). The suite is "N scenarios over K rules", not N independent rules.

## VAT rules (`pricing_router`)

| Customer | `taxMode` | VAT |
| --- | --- | --- |
| Germany (B2B or B2C) | `DE_19` | 19% |
| other EU country with a valid VAT ID | `EU_REVERSE_CHARGE` | 0 |
| other EU country without a VAT ID | `EU_OSS` | that country's standard rate (e.g. FR 20%, NL 21%, FI 25.5%) |
| US, CH, GB, NO, CA, AU | `NON_EU_EXPORT` | 0 |
| any other country code | the oracle throws (never 0%) | |

Standard rates are listed with their source and retrieval date in `reference.mjs`. Reduced rates, special territories and OSS thresholds are not modelled. Inputs are validated (`seats` integer >= 1, `couponPct` integer 0..100, boolean flags, known tier).

## Sandbox: what is enforced

The candidate is untrusted code. `checker/sandbox.mjs` runs it in a **separate Node process** started with:

```text
node --permission --allow-fs-read=<checker/child.mjs> --allow-fs-read=<copy of the candidate bytes> \
     --disallow-code-generation-from-strings --max-old-space-size=256 checker/child.mjs <module> <export>
```

with an empty environment (`env: {}`), stdout and stderr discarded, a wall-clock timeout (20 s per request, then `SIGKILL`, verdict `timeout`) and a 32 MiB cap on what the child may send back. Requests go to the child over stdin and replies come back on a dedicated pipe (fd 3), never on stdout. The parent takes the decisions, validates them against a strict schema and writes the verdict itself. `reference.mjs`, the scenario generators and `targets.json` are never readable from the child.

Checked empirically on Node 26.13.1 (`node --permission --allow-fs-read=<probe> probe.mjs`, with a probe that tries each API from inside the sandbox):

| Blocked (`ERR_ACCESS_DENIED` or similar) | Not blocked |
| --- | --- |
| reading any file outside the two allowed paths (including `reference.mjs`, `/etc/hosts`, the working directory) | CPU and memory use up to the timeout and `--max-old-space-size` (the child is killed, the verdict is `timeout`/`trapped`) |
| any file write (`writeFileSync`, `writeHeapSnapshot`) | reading its own environment (empty here) and `process.report` metadata such as the cwd |
| `child_process`, `worker_threads`, native addons (`process.dlopen`), `node:wasi`, the inspector, `process.binding` | `process.kill()` on the parent or other processes of the same OS user (signals are not covered by the permission model) |
| network: `net`, `dns`, `dgram`, `http` and `fetch` (`--allow-net` is not granted, and the permission model denies network by default) | writing to its own stdout or exit code (both ignored by the parent, and a child that dies without a reply is `trapped`) |
| `Function(...)`, `eval`, `new Function`, `.constructor.constructor(...)` (`--disallow-code-generation-from-strings`) | |

What this does **not** give you: the permission model is a Node-level guardrail, not a kernel sandbox. A Node or V8 vulnerability is out of scope, a hostile candidate can still signal processes of the same OS user (`process.kill`, including the verifier: that run then writes no verdict and `scripts/check.sh` fails closed), and it shares its process with `checker/child.mjs`, so it can reach the stdin/fd 3 pipes (everything it sends is validated, and it must still return answers the oracle accepts, but it can fake the wire format). Run the judge job in an unprivileged container or VM with **no network egress and no secrets** (for example a job with no `VERDICT_SECRET`, `--network none` when run through Docker), exactly as CONTRACT.md section 4 requires; the template does not replace that. The sandbox needs a Node that knows `--allow-net` (everything above was verified on Node 26.13.1; older versions were not tested). The verifier checks `process.allowedNodeEnvironmentFlags.has('--allow-net')` and otherwise refuses to run the candidate (`fault`); it never runs it unsandboxed.

The regex source guard (`guard_rejected`: comments, `import`, `eval`, `constructor`, `process`, ...) is kept only as a cheap first filter. It is trivially bypassable (`global['pro'+'cess']`), which is why it is not the boundary.

## Verdict handling

`scripts/check.sh <target>` runs the verifier with `--out <tmpfile>` and reads the verdict from that file written by the parent process; it never parses the verifier's stdout, and a missing or empty file fails the check. Reasons in the verdict come from fixed templates and never echo candidate-provided strings.

## Limits

Fresh scenarios are random, so a cheat that is wrong only on a narrow input outside the boundary values and the 1..300 / 0..100 sweeps is caught with probability that depends on the number of fresh rows, not with certainty. Raise `randomCount` in `buildFreshScenarios` for higher-stakes targets.

## Quick start

```bash
scripts/check.sh                   # self-check baseline compliance & eval suite
scripts/check.sh pricing_router    # compare working copy against origin/main holder
```
