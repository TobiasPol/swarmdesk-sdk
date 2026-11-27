// Loads one target from targets.json: its export name, how arguments are passed, its frozen reference
// and its input generators. Trusted code, verifier process only; nothing here is readable from the
// sandbox child.
//
// Outputs are compared as outcomes: 'v' + the JSON text of the value (so key order counts), 'u' when
// the function returns undefined (or a value JSON cannot represent), 't' when it throws. A candidate
// must produce the reference's outcome on every input; the type and message of a thrown error are not
// compared.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { IDENTIFIER } from './guard.mjs';

export const DEFAULT_ROUND_SIZE = 4800;

export function loadManifest(manifestPath) {
  const abs = resolve(manifestPath);
  return { rootDir: dirname(abs), manifest: JSON.parse(readFileSync(abs, 'utf8')) };
}

export function findTarget(manifest, name) {
  return (manifest.targets ?? []).find((t) => t.name === name) ?? null;
}

const importFrom = async (path) => import(pathToFileURL(path).href);

/**
 * spec fields: name, file_path, export (default "jsonEscape"), args ("single" passes each input as the
 * one argument, "spread" passes each input array as the argument list), round_size.
 */
export async function loadTarget(rootDir, spec) {
  const exportName = spec.export ?? 'jsonEscape';
  if (!IDENTIFIER.test(exportName)) throw new Error('invalid export name');
  if (spec.args !== undefined && spec.args !== 'single' && spec.args !== 'spread') {
    throw new Error('args must be "single" or "spread"');
  }
  const dir = resolve(rootDir, 'targets', spec.name);
  const ref = await importFrom(resolve(dir, 'reference.mjs'));
  const data = await importFrom(resolve(dir, 'dataset.mjs'));
  if (typeof ref[exportName] !== 'function') throw new Error(`reference lacks ${exportName}`);
  if (typeof data.golden !== 'function' || typeof data.fresh !== 'function') {
    throw new Error('dataset.mjs must export golden() and fresh(seed, size)');
  }
  const spread = spec.args === 'spread';
  const refFn = ref[exportName];
  return {
    name: spec.name,
    exportName,
    spread,
    roundSize: Number.isInteger(spec.round_size) && spec.round_size > 0 ? spec.round_size : DEFAULT_ROUND_SIZE,
    golden: () => data.golden(),
    fresh: (seed, size) => data.fresh(seed, size),
    // Each input is cloned first, so a reference that mutates its arguments cannot change what the
    // candidate is later sent.
    expect: (inputs) => inputs.map((input) => referenceOutcome(refFn, structuredClone(input), spread)),
  };
}

function referenceOutcome(fn, input, spread) {
  let value;
  try {
    value = spread ? fn(...input) : fn(input);
  } catch {
    return 't';
  }
  const json = value === undefined ? undefined : JSON.stringify(value);
  return json === undefined ? 'u' : `v${json}`;
}

/** Maps one parsed sandbox result (see parseReply in sandbox.mjs) to an outcome. */
export function candidateOutcome(result) {
  if (result.ok) {
    const json = JSON.stringify(result.value);
    return json === undefined ? 'u' : `v${json}`;
  }
  return result.undef ? 'u' : 't';
}
