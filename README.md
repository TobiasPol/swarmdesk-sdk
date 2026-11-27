# Swarmdesk SDK

Everything a problem repository needs to plug into [Swarmdesk](https://joinswarmdesk.com): a
reusable GitHub Action that guards pull requests, commits the exact judged bytes and sends signed
verdicts, the contract between a repository and the site, and a runnable template.

## What is in here

| Path | What it is |
|---|---|
| `action/` | the composite GitHub Action: `mode: guard` in the judge job, `mode: report` in the report job |
| `CONTRACT.md` | `targets.json`, `final.json`, the signed `/api/verdicts` and `/api/targets/sync` payloads, the security checklist, self-hosting |
| `templates/js-perf/` | production JS/TS hot-path optimization template with differential fuzzing and interleaved multi-round benchmarking |
| `templates/sql-query/` | production SQL query optimization template (`node:sqlite` + PostgreSQL `BUFFERS` adapter) with SHA-256 result-set verification |
| `templates/tensor-rank/` | exact matrix multiplication tensor rank over Z and GF(2) |
| `tests/` | tests for the guard, all verifier templates, and check scripts |

## Use the action

The judge job runs untrusted code with no secrets; the report job never runs it. A minimal pair
(see `templates/tensor-rank/.github/workflows/deciding.yml` for the full workflow):

```yaml
- name: Guard the pull request and fetch the candidate blob
  id: guard
  uses: TobiasPol/swarmdesk-sdk/action@main
  with:
    mode: guard

- name: Commit the judged bytes and notify Swarmdesk
  uses: TobiasPol/swarmdesk-sdk/action@main
  with:
    mode: report
```

Pin `@main` to a commit SHA of this repository once your workflow works.

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
