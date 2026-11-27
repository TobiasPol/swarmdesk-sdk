# JS/TS Hot-Path Optimization Template (`js-perf`)

A zero-dependency Swarmdesk problem template for optimizing latency-critical JavaScript functions (parsers, encoders, string utilities) with differential testing and interleaved, parent-timed benchmarking.

## How it works

1. `targets/<name>/reference.mjs` holds the frozen ground-truth oracle (verifier process only).
2. `targets/<name>/candidate.mjs` holds the current record holder that agents optimize.
3. `checker/dataset.mjs` generates inputs: a fixed public golden set (607 strings) and **fresh** random strings per run from a random seed that is recorded in the verdict (`class_fuel.seed`, reproduce with `--seed <n>`).
4. `checker/verify.mjs` guards the source, then runs the benchmark in 4 independent process pairs (two fresh processes can differ by a few percent for identical code). In each pair holder and candidate each run 9 rounds (3 warm-up, 6 timed) in their own sandboxed child, **one after the other, never alive at the same time** (so a candidate cannot signal or burn CPU against the holder), and the order alternates per pair. Round k of both sides uses the same dataset of 4,800 strings; datasets are never reused: every round seed is `sha256(master seed : pair : round)` from a 48-bit random master seed, so earlier rounds reveal nothing about later ones, and a cache keyed on the input cannot hit. The **parent** takes the time around each whole request (including IPC), so the candidate cannot influence the clock, and every output of every round is verified against the oracle. The candidate is accepted if the mean over pairs of (1 - median of that pair's candidate/holder time ratios) is at least 5% and it wins at least 75% of the 24 paired rounds. The holder compared with itself is rejected (about half the rounds are won).
5. Pair with `TobiasPol/swarmdesk-sdk/action@<commit sha>` (`mode: guard` / `mode: report`; pin the action to a commit, see CONTRACT.md) and `npx swarmdesk-cli loop` for overnight optimization sprints.

`targets.json` `baseline_value`/`sota_value` are indicative microseconds per round measured on one development machine; verdicts compare holder and candidate on the same machine in the same run, never against those numbers.

Because the parent times a full round trip, a fixed IPC cost is part of both scores; a real speed-up still shows, but the reported cut is smaller than an in-process measurement would give.

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

## Quick start

```bash
scripts/check.sh                # self-check baseline equivalence
scripts/check.sh json_escape    # compare working copy against origin/main holder
```
