#!/usr/bin/env node
// Generic Pull Request guard for Swarmdesk problem repositories.
// Plain Node ESM, zero dependencies. Reads GitHub API JSON responses and targets.json; never checks out forks.
//
//   node pr-guard.mjs pr <pr.json> <files.json> <tree.json> <commits.json> <targets.json> <repo> <default_branch>
//   node pr-guard.mjs step <steps.json> <step_id> <target> [<targets.json>]
//   node pr-guard.mjs limits <search.json> <comments.json>
//   node pr-guard.mjs manifest <targets.json>
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const BRANCH_RE = /^step-([1-9][0-9]{0,8})$/;
export const ALLOWED_KINDS = new Set(['score', 'bound', 'conjecture', 'lemma', 'custom']);
export const MAX_BYTES = 512 * 1024;
export const MAX_CONFIGURABLE_BYTES = 10 * 1024 * 1024;
export const MAX_OPEN = 3;
export const MAX_VERDICTS = 30;

const SHA_RE = /^[0-9a-f]{40}$/;
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const PROBLEM_SLUG_RE = /^[a-z0-9-]{2,48}$/;
const TARGET_SLUG_RE = /^[a-z0-9_]{1,48}$/;
const REL_PATH_RE = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

export class Refused extends Error {}

const refuse = (why) => {
  throw new Refused(why);
};

function resolveMaxBytes(manifest, options) {
  const candidate = options?.maxBytes ?? manifest?.max_bytes;
  if (candidate === undefined || candidate === null) return MAX_BYTES;
  if (Number.isInteger(candidate) && candidate >= 1 && candidate <= MAX_CONFIGURABLE_BYTES) {
    return candidate;
  }
  return MAX_BYTES;
}

function isSafeRelPath(p) {
  if (typeof p !== 'string' || !REL_PATH_RE.test(p)) return false;
  return !p.split('/').some((seg) => seg === '.' || seg === '..');
}

function checkDepCycle(byName, name, state) {
  const cur = state.get(name);
  if (cur === 2) return;
  if (cur === 1) refuse(`dependency cycle involving ${name}`);
  state.set(name, 1);
  const target = byName.get(name);
  for (const dep of target.depends_on ?? []) {
    checkDepCycle(byName, dep, state);
  }
  state.set(name, 2);
}

export function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    refuse('targets.json must be a JSON object');
  }
  if (!PROBLEM_SLUG_RE.test(manifest.problem ?? '')) {
    refuse('manifest.problem must be a valid slug');
  }
  const targets = manifest.targets;
  if (!Array.isArray(targets) || targets.length === 0 || targets.length > 200) {
    refuse('manifest.targets must be a non-empty array of at most 200 items');
  }
  const byName = new Map();
  const paths = new Set();
  for (const t of targets) {
    if (!t || typeof t !== 'object' || Array.isArray(t)) {
      refuse('every target entry must be an object');
    }
    if (!TARGET_SLUG_RE.test(t.name ?? '')) refuse(`invalid target slug: ${String(t.name ?? '').slice(0, 32)}`);
    if (byName.has(t.name)) refuse(`duplicate target name: ${t.name}`);
    if (!ALLOWED_KINDS.has(t.kind)) refuse(`invalid target kind for ${t.name}`);
    if (!isSafeRelPath(t.file_path)) refuse(`invalid file_path for ${t.name}`);
    if (paths.has(t.file_path)) refuse(`duplicate file_path: ${t.file_path}`);
    if (t.depends_on !== undefined && !Array.isArray(t.depends_on)) {
      refuse(`depends_on for ${t.name} must be an array`);
    }
    if ((t.kind === 'bound' || t.kind === 'score') && t.direction !== undefined) {
      if (t.direction !== 'maximize' && t.direction !== 'minimize') {
        refuse(`invalid direction for ${t.name}`);
      }
    }
    if (t.kind === 'bound' && (typeof t.baseline_value !== 'number' || !Number.isFinite(t.baseline_value))) {
      refuse(`bound target ${t.name} requires a finite baseline_value`);
    }
    byName.set(t.name, t);
    paths.add(t.file_path);
  }
  for (const t of targets) {
    for (const dep of t.depends_on ?? []) {
      if (typeof dep !== 'string' || !byName.has(dep)) {
        refuse(`target ${t.name} depends on unknown target ${String(dep).slice(0, 32)}`);
      }
      if (dep === t.name) refuse(`target ${t.name} cannot depend on itself`);
    }
    if (t.kind === 'lemma' && t.parent !== undefined && !byName.has(t.parent)) {
      refuse(`lemma ${t.name} references unknown parent ${String(t.parent).slice(0, 32)}`);
    }
  }
  const state = new Map();
  for (const t of targets) {
    checkDepCycle(byName, t.name, state);
  }
  return { ok: true, problem: manifest.problem, count: targets.length };
}

export function checkPr(pr, files, tree, commits, manifest, repo, defaultBranch, options = {}) {
  if (pr?.state !== 'open') refuse('the pull request is not open');
  if (pr.base?.repo?.full_name !== repo) refuse('the pull request is not against this repository');
  if (pr.base?.ref !== defaultBranch) refuse(`the pull request is not against ${defaultBranch}`);

  const head = pr.head?.sha;
  if (!SHA_RE.test(head ?? '')) refuse('the pull request has no head commit');
  const author = pr.user?.login;
  if (!LOGIN_RE.test(author ?? '')) refuse('the author is not a plain account name');
  const branch = BRANCH_RE.exec(pr.head?.ref ?? '');
  if (!branch) refuse('the branch must be named step-<number>, as the desk gave it');

  if (pr.commits !== 1 || !Array.isArray(commits) || commits.length !== 1) {
    refuse('the pull request must have exactly one commit');
  }
  if (commits[0]?.sha !== head) refuse('the commit list and the head commit disagree');
  if (commits[0]?.commit?.message !== pr.head.ref) {
    refuse('the commit message must be the branch name');
  }

  if (pr.changed_files !== 1 || !Array.isArray(files) || files.length !== 1) {
    refuse('the pull request must change exactly one file');
  }
  const file = files[0];
  const targets = Array.isArray(manifest?.targets) ? manifest.targets : [];
  const matched = targets.find((t) => t?.file_path === file?.filename);
  if (!matched) refuse('the modified file must match a target file_path in targets.json');
  if (!ALLOWED_KINDS.has(matched.kind)) refuse('the matched target has an unsupported kind');

  if (matched.depends_on !== undefined) {
    if (!Array.isArray(matched.depends_on) || matched.depends_on.some((d) => typeof d !== 'string' || !TARGET_SLUG_RE.test(d))) {
      refuse('the matched target has invalid depends_on metadata');
    }
  }

  if (file.status !== 'modified') {
    refuse(`the file must be modified, not ${String(file.status).slice(0, 20)}`);
  }
  if (!SHA_RE.test(file.sha ?? '')) refuse('the file list names no content hash');
  if (tree?.truncated) refuse('the tree of the head commit is too large to read');

  const treeEntries = Array.isArray(tree?.tree) ? tree.tree : [];
  const entries = treeEntries.filter((e) => e?.path === file.filename);
  if (entries.length !== 1) refuse('the file is not in the tree of the head commit');
  const entry = entries[0];
  if (entry.mode === '120000') refuse('symlinks are not allowed');
  if (entry.type !== 'blob' || entry.mode !== '100644') refuse('the file must be a plain file');
  if (entry.sha !== file.sha) refuse('the file list and the tree disagree about the content');

  const maxBytes = resolveMaxBytes(manifest, options);
  if (!Number.isInteger(entry.size) || entry.size < 1 || entry.size > maxBytes) {
    refuse(`the file must be between 1 and ${maxBytes} bytes`);
  }

  return {
    target: matched.name,
    kind: matched.kind,
    file_path: matched.file_path,
    depends_on: Array.isArray(matched.depends_on) ? matched.depends_on : [],
    step: Number(branch[1]),
    head,
    blob: file.sha,
    author,
  };
}

export function checkStep(list, step, target, manifest = null) {
  if (!Number.isInteger(step) || step < 1) refuse('step must be a positive integer');
  const steps = Array.isArray(list?.steps) ? list.steps : refuse('the desk sent no step list');
  const found = steps.find((s) => s?.id === step);
  if (!found) refuse(`step-${step} is not open at the desk`);
  if (found.target !== target) refuse(`step-${step} is not a step for this target`);

  const resolvedList = Array.isArray(list?.resolved)
    ? list.resolved
    : Array.isArray(list?.solved_targets)
      ? list.solved_targets
      : null;
  if (resolvedList && manifest && Array.isArray(manifest.targets)) {
    const entry = manifest.targets.find((t) => t?.name === target);
    const deps = Array.isArray(entry?.depends_on) ? entry.depends_on : [];
    const resolved = new Set(resolvedList);
    for (const dep of deps) {
      if (!resolved.has(dep)) {
        refuse(`target ${target} depends on unresolved target ${dep}`);
      }
    }
  }
  return { step, target };
}

export function checkLimits(search, comments, options = {}) {
  const maxOpen = options.maxOpen ?? MAX_OPEN;
  const maxVerdicts = options.maxVerdicts ?? MAX_VERDICTS;
  const mine = search?.total_count;
  if (!Number.isInteger(mine) || mine < 0 || !Array.isArray(comments)) {
    refuse('the limits could not be read');
  }
  if (search.incomplete_results !== false) refuse('the limits could not be read: push again');
  if (mine > maxOpen) {
    refuse(`you have ${mine} open pull requests: at most ${maxOpen} are judged at a time`);
  }
  const verdicts = comments.filter((c) => c?.user?.login === 'github-actions[bot]').length;
  if (verdicts >= maxVerdicts) {
    refuse(`this pull request has been judged ${maxVerdicts} times: open a new one`);
  }
  return { open: mine, verdicts };
}

const json = (path) => JSON.parse(readFileSync(path, 'utf8'));

function main(argv) {
  const [mode, ...rest] = argv;
  if (mode === 'pr' && rest.length === 7) {
    return checkPr(
      json(rest[0]),
      json(rest[1]),
      json(rest[2]),
      json(rest[3]),
      json(rest[4]),
      rest[5],
      rest[6],
    );
  }
  if (mode === 'step' && (rest.length === 3 || rest.length === 4)) {
    return checkStep(
      json(rest[0]),
      Number(rest[1]),
      rest[2],
      rest[3] ? json(rest[3]) : null,
    );
  }
  if (mode === 'limits' && rest.length === 2) {
    return checkLimits(json(rest[0]), json(rest[1]));
  }
  if (mode === 'manifest' && rest.length === 1) {
    return validateManifest(json(rest[0]));
  }
  console.error(
    'usage: pr-guard.mjs pr <pr> <files> <tree> <commits> <targets> <repo> <branch> | step <steps> <id> <target> [<targets>] | limits <search> <comments> | manifest <targets>',
  );
  process.exit(3);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    console.log(JSON.stringify(main(process.argv.slice(2))));
  } catch (error) {
    const reason = error instanceof Refused ? error.message : 'the pull request could not be read';
    console.log(JSON.stringify({ refused: reason }));
    process.exit(1);
  }
}
