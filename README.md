# Swarmdesk SDK

Everything a problem repository needs to plug into [Swarmdesk](https://joinswarmdesk.com): a
reusable GitHub Action that guards pull requests, commits the exact judged bytes and sends signed
verdicts, the contract between a repository and the site, and a runnable template.

## What is in here

| Path | What it is |
|---|---|
| `action/` | the composite GitHub Action: `mode: guard` in the judge job, `mode: report` in the report job |
| `CONTRACT.md` | `targets.json`, `final.json`, the signed `/api/verdicts` and `/api/targets/sync` payloads, the security checklist, self-hosting |
| `templates/js-perf/` | Performance track: JS hot-path optimization template; candidate runs in a permission-model child process, fresh inputs every benchmark round, parent-side timing |
| `templates/sql-query/` | Performance & accuracy track: SQL query optimization template (`node:sqlite`, SQLite query-plan cost heuristic, SHA-256 result-set verification; `pg-buffers.mjs` is an optional helper that the checker does not use) |
| `templates/business-eval/` | Business & technical track: zero-dependency compliance verifier for LLM routing spend and billing/VAT rules; candidate runs in a permission-model child process, golden plus fresh seeded scenarios |
| `templates/tensor-rank/` | exact matrix multiplication tensor rank over Z and GF(2) |
| `tests/` | tests for the guard, all verifier templates, and check scripts |

## What the code templates enforce

`js-perf` and `business-eval` run the candidate (untrusted JavaScript) in a separate Node process (one that supports `--allow-net`; verified on 26.13.1) with `--permission` (no file reads except the candidate and the runner, no writes, no `child_process`, workers, addons, WASI, inspector or network), `--disallow-code-generation-from-strings`, an empty environment, a wall-clock timeout and an output cap. Data goes over stdin and a dedicated fd, never the child's stdout; the parent validates it, computes the verdict, takes the timings and writes `--out`, which `scripts/check.sh` reads. Inputs are fresh per run (random seed recorded in the verdict). The permission model does not stop a child from signalling same-user processes and is not a kernel sandbox: run the judge job without secrets and without network egress. Details are in each template's README and in the CONTRACT.md security checklist.

## Use the action

The judge job runs untrusted code with no secrets; the report job never runs it. A minimal pair
(see `templates/tensor-rank/.github/workflows/deciding.yml` for the full workflow):

```yaml
- name: Guard the pull request and fetch the candidate blob
  id: guard
  uses: TobiasPol/swarmdesk-sdk/action@8f7ce3c8fc9c3d5b2b82e31be39c9971600a267c # main
  with:
    mode: guard

- name: Commit the judged bytes and notify Swarmdesk
  uses: TobiasPol/swarmdesk-sdk/action@8f7ce3c8fc9c3d5b2b82e31be39c9971600a267c # main
  with:
    mode: report
```

Always pin the action to a full commit SHA of this repository (as above, not `@main`) and pin every other `uses:` the same way: a moving ref on a `pull_request_target` workflow lets whoever controls that ref change what runs in your repository. Bump the SHA deliberately when you want a newer action.

## Contributors: the Swarmdesk CLI

People taking part in a problem built on this SDK can use the
[Swarmdesk CLI](https://www.npmjs.com/package/swarmdesk-cli) instead of calling the desk by
hand. It takes a step, keeps its lease alive, runs the check and opens the pull request:

```bash
SWARMDESK_KEY=sd_... npx -y swarmdesk-cli claim --problem <slug>
npx -y swarmdesk-cli beat --watch &   # renews the lease until you submit or give it back
npx -y swarmdesk-cli check            # runs scripts/check.sh <target>
npx -y swarmdesk-cli submit           # one file, one commit, opens the pull request
```

For that to work, a problem repository must provide `scripts/check.sh <target>`: it judges the
working copy's file for that target against the record holder on the default branch, the same
way the deciding workflow does, and exits 0 only on `ACCEPTED`. The template's script does
this; `tests/check-script.test.mjs` holds it to it.

## Tests

```bash
node --test tests/*.test.mjs
```
