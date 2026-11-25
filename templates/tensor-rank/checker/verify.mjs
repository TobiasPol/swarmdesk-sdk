#!/usr/bin/env node
// Zero-dependency exact verifier for matrix-multiplication bilinear rank decompositions over Z and GF(2).
//
// Usage:
//   node checker/verify.mjs --self-check [targets.json]
//   node checker/verify.mjs verify --targets targets.json --target <name> --candidate <file> [--holder <file>] [--out <final.json>]
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_MAX_BYTES = 512 * 1024;
export const MAX_RANK = 512;
export const MAX_INT_ABS = 1_000_000;

const REQUIRED_KEYS = ['target', 'ring', 'm', 'k', 'n', 'rank', 'u', 'v', 'w'];
const ALLOWED_KEYS = new Set(REQUIRED_KEYS);

function rejected(reasonCode, reason, extra = {}) {
  return {
    verdict: 'REJECTED',
    reason_code: reasonCode,
    reason,
    resolution: '',
    metric_value: extra.metric_value ?? null,
    holder_value: extra.holder_value ?? null,
    proof_lines: 0,
    wasm_bytes: 0,
    class_fuel: '{}',
  };
}

function validateMatrix(mat, rows, cols, ring, label) {
  if (!Array.isArray(mat) || mat.length !== rows) {
    return `${label} must have ${rows} rows`;
  }
  for (let r = 0; r < rows; r += 1) {
    const row = mat[r];
    if (!Array.isArray(row) || row.length !== cols) {
      return `${label}[${r}] must have ${cols} columns`;
    }
    for (let c = 0; c < cols; c += 1) {
      const val = row[c];
      if (!Number.isSafeInteger(val)) {
        return `${label}[${r}][${c}] must be an integer`;
      }
      if (ring === 'GF2') {
        if (val !== 0 && val !== 1) return `${label}[${r}][${c}] must be 0 or 1 over GF2`;
      } else if (Math.abs(val) > MAX_INT_ABS) {
        return `${label}[${r}][${c}] exceeds magnitude limit ${MAX_INT_ABS}`;
      }
    }
  }
  return null;
}

export function parseAndValidateSubmission(rawText, targetSpec, maxBytes = DEFAULT_MAX_BYTES) {
  if (typeof rawText !== 'string' || rawText.length === 0) {
    return { ok: false, error: rejected('schema_error', 'submission file is empty') };
  }
  const byteLen = Buffer.byteLength(rawText, 'utf8');
  if (byteLen > maxBytes) {
    return { ok: false, error: rejected('size_limit', `submission exceeds ${maxBytes} bytes`) };
  }
  if (rawText.includes('\0') || rawText.charCodeAt(0) === 0xfeff) {
    return { ok: false, error: rejected('schema_error', 'submission contains invalid control bytes') };
  }

  let doc;
  try {
    doc = JSON.parse(rawText);
  } catch {
    return { ok: false, error: rejected('schema_error', 'submission is not valid strict JSON') };
  }

  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { ok: false, error: rejected('schema_error', 'submission root must be a JSON object') };
  }

  const keys = Object.keys(doc);
  for (const key of keys) {
    if (!ALLOWED_KEYS.has(key)) {
      return { ok: false, error: rejected('schema_error', `unexpected field: ${key.slice(0, 32)}`) };
    }
  }
  for (const req of REQUIRED_KEYS) {
    if (!(req in doc)) {
      return { ok: false, error: rejected('schema_error', `missing required field: ${req}`) };
    }
  }

  if (doc.target !== targetSpec.name) {
    return { ok: false, error: rejected('schema_error', 'target name does not match target spec') };
  }
  if (doc.ring !== targetSpec.ring) {
    return { ok: false, error: rejected('schema_error', `ring must be ${targetSpec.ring}`) };
  }
  if (doc.m !== targetSpec.m || doc.k !== targetSpec.k || doc.n !== targetSpec.n) {
    return {
      ok: false,
      error: rejected(
        'schema_error',
        `dimensions must be ${targetSpec.m}x${targetSpec.k}x${targetSpec.n}`,
      ),
    };
  }
  if (!Number.isInteger(doc.rank) || doc.rank < 1 || doc.rank > MAX_RANK) {
    return { ok: false, error: rejected('schema_error', `rank must be an integer in 1..${MAX_RANK}`) };
  }
  const R = doc.rank;
  if (!Array.isArray(doc.u) || doc.u.length !== R || !Array.isArray(doc.v) || doc.v.length !== R || !Array.isArray(doc.w) || doc.w.length !== R) {
    return { ok: false, error: rejected('schema_error', 'u, v, and w must each have length rank') };
  }

  for (let r = 0; r < R; r += 1) {
    const uErr = validateMatrix(doc.u[r], targetSpec.m, targetSpec.k, targetSpec.ring, `u[${r}]`);
    if (uErr) return { ok: false, error: rejected('schema_error', uErr) };
    const vErr = validateMatrix(doc.v[r], targetSpec.k, targetSpec.n, targetSpec.ring, `v[${r}]`);
    if (vErr) return { ok: false, error: rejected('schema_error', vErr) };
    const wErr = validateMatrix(doc.w[r], targetSpec.m, targetSpec.n, targetSpec.ring, `w[${r}]`);
    if (wErr) return { ok: false, error: rejected('schema_error', wErr) };
  }

  return { ok: true, doc };
}

function nonzeroEntries(mat, rows, cols) {
  const out = [];
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const v = mat[r][c];
      if (v !== 0) out.push([r, c, v]);
    }
  }
  return out;
}

/**
 * Verifies exact identity:
 *   sum_{r=0}^{R-1} u[r][i][k] * v[r][kp][j] * w[r][ip][jp] == delta(i, ip) * delta(k, kp) * delta(j, jp)
 * over Z (exact BigInt) or GF(2) (mod 2).
 */
export function verifyTensorIdentity(doc) {
  const { m, k, n, rank, ring, u, v, w } = doc;
  const strideA = k;
  const strideB = n;
  const strideC = n;
  const dimA = m * k;
  const dimB = k * n;
  const dimC = m * n;
  const total = dimA * dimB * dimC;

  if (ring === 'GF2') {
    const acc = new Uint8Array(total);
    for (let r = 0; r < rank; r += 1) {
      const nzU = nonzeroEntries(u[r], m, k);
      const nzV = nonzeroEntries(v[r], k, n);
      const nzW = nonzeroEntries(w[r], m, n);
      for (const [i, kk] of nzU) {
        const aIdx = i * strideA + kk;
        for (const [kp, j] of nzV) {
          const bIdx = kp * strideB + j;
          const abBase = (aIdx * dimB + bIdx) * dimC;
          for (const [ip, jp] of nzW) {
            const cIdx = ip * strideC + jp;
            acc[abBase + cIdx] ^= 1;
          }
        }
      }
    }
    for (let i = 0; i < m; i += 1) {
      for (let kk = 0; kk < k; kk += 1) {
        const aIdx = i * strideA + kk;
        for (let kp = 0; kp < k; kp += 1) {
          for (let j = 0; j < n; j += 1) {
            const bIdx = kp * strideB + j;
            const abBase = (aIdx * dimB + bIdx) * dimC;
            for (let ip = 0; ip < m; ip += 1) {
              for (let jp = 0; jp < n; jp += 1) {
                const cIdx = ip * strideC + jp;
                const expected = i === ip && kk === kp && j === jp ? 1 : 0;
                if (acc[abBase + cIdx] !== expected) {
                  return {
                    ok: false,
                    mismatch: [i, kk, kp, j, ip, jp],
                    got: acc[abBase + cIdx],
                    expected,
                  };
                }
              }
            }
          }
        }
      }
    }
    return { ok: true };
  }

  const acc = new BigInt64Array(total);
  for (let r = 0; r < rank; r += 1) {
    const nzU = nonzeroEntries(u[r], m, k);
    const nzV = nonzeroEntries(v[r], k, n);
    const nzW = nonzeroEntries(w[r], m, n);
    for (const [i, kk, uVal] of nzU) {
      const aIdx = i * strideA + kk;
      const bu = BigInt(uVal);
      for (const [kp, j, vVal] of nzV) {
        const bIdx = kp * strideB + j;
        const buv = bu * BigInt(vVal);
        const abBase = (aIdx * dimB + bIdx) * dimC;
        for (const [ip, jp, wVal] of nzW) {
          const cIdx = ip * strideC + jp;
          acc[abBase + cIdx] += buv * BigInt(wVal);
        }
      }
    }
  }
  for (let i = 0; i < m; i += 1) {
    for (let kk = 0; kk < k; kk += 1) {
      const aIdx = i * strideA + kk;
      for (let kp = 0; kp < k; kp += 1) {
        for (let j = 0; j < n; j += 1) {
          const bIdx = kp * strideB + j;
          const abBase = (aIdx * dimB + bIdx) * dimC;
          for (let ip = 0; ip < m; ip += 1) {
            for (let jp = 0; jp < n; jp += 1) {
              const cIdx = ip * strideC + jp;
              const expected = i === ip && kk === kp && j === jp ? 1n : 0n;
              if (acc[abBase + cIdx] !== expected) {
                return {
                  ok: false,
                  mismatch: [i, kk, kp, j, ip, jp],
                  got: Number(acc[abBase + cIdx]),
                  expected: Number(expected),
                };
              }
            }
          }
        }
      }
    }
  }
  return { ok: true };
}

export function verifyCandidate(rawText, targetSpec, holderRank, maxBytes = DEFAULT_MAX_BYTES) {
  const parsed = parseAndValidateSubmission(rawText, targetSpec, maxBytes);
  if (!parsed.ok) {
    return {
      ...parsed.error,
      holder_value: holderRank,
    };
  }
  const { doc } = parsed;
  const idCheck = verifyTensorIdentity(doc);
  if (!idCheck.ok) {
    return rejected(
      'wrong_answer',
      `tensor identity failed at (${idCheck.mismatch.join(',')})`,
      { metric_value: doc.rank, holder_value: holderRank },
    );
  }
  if (doc.rank >= holderRank) {
    return rejected(
      'bound_not_improved',
      `rank ${doc.rank} does not beat holder rank ${holderRank}`,
      { metric_value: doc.rank, holder_value: holderRank },
    );
  }
  return {
    verdict: 'ACCEPTED',
    reason_code: '',
    reason: `verified rank ${doc.rank} strictly improves on holder rank ${holderRank}`,
    resolution: 'improved',
    metric_value: doc.rank,
    holder_value: holderRank,
    proof_lines: 0,
    wasm_bytes: 0,
    class_fuel: '{}',
  };
}

export function verifySelfCheck(manifestPath) {
  const absManifest = resolve(manifestPath);
  const rootDir = dirname(absManifest);
  const manifest = JSON.parse(readFileSync(absManifest, 'utf8'));
  const maxBytes = manifest.max_bytes ?? DEFAULT_MAX_BYTES;
  const results = [];
  let allOk = true;
  for (const target of manifest.targets ?? []) {
    const filePath = resolve(rootDir, target.file_path);
    const raw = readFileSync(filePath, 'utf8');
    const parsed = parseAndValidateSubmission(raw, target, maxBytes);
    if (!parsed.ok) {
      allOk = false;
      results.push({ target: target.name, ok: false, reason_code: parsed.error.reason_code, reason: parsed.error.reason });
      continue;
    }
    const idCheck = verifyTensorIdentity(parsed.doc);
    if (!idCheck.ok) {
      allOk = false;
      results.push({ target: target.name, ok: false, reason_code: 'wrong_answer', reason: `mismatch at ${idCheck.mismatch.join(',')}` });
      continue;
    }
    if (parsed.doc.rank > target.baseline_value) {
      allOk = false;
      results.push({ target: target.name, ok: false, reason_code: 'bound_not_improved', reason: `rank ${parsed.doc.rank} > baseline ${target.baseline_value}` });
      continue;
    }
    results.push({ target: target.name, ok: true, rank: parsed.doc.rank, ring: parsed.doc.ring });
  }
  return { ok: allOk, checked: results.length, results };
}

function parseFlags(args) {
  const out = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const val = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : 'true';
      out[key] = val;
    }
  }
  return out;
}

function main(argv) {
  if (argv[0] === '--self-check') {
    const res = verifySelfCheck(argv[1] ?? 'targets.json');
    console.log(JSON.stringify(res, null, 2));
    process.exit(res.ok ? 0 : 1);
  }
  if (argv[0] === 'verify') {
    const flags = parseFlags(argv.slice(1));
    const manifestPath = flags.targets ?? 'targets.json';
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const targetSpec = (manifest.targets ?? []).find((t) => t.name === flags.target);
    if (!targetSpec) {
      const err = rejected('schema_error', 'unknown target');
      if (flags.out) writeFileSync(flags.out, `${JSON.stringify(err)}\n`);
      console.log(JSON.stringify(err));
      process.exit(0);
    }
    let holderRank = targetSpec.baseline_value;
    if (flags.holder) {
      const holderDoc = JSON.parse(readFileSync(flags.holder, 'utf8'));
      if (Number.isInteger(holderDoc?.rank)) holderRank = holderDoc.rank;
    }
    const rawCandidate = readFileSync(flags.candidate, 'utf8');
    const verdict = verifyCandidate(
      rawCandidate,
      targetSpec,
      holderRank,
      manifest.max_bytes ?? DEFAULT_MAX_BYTES,
    );
    if (flags.out) writeFileSync(flags.out, `${JSON.stringify(verdict)}\n`);
    console.log(JSON.stringify(verdict));
    process.exit(0);
  }
  console.error('usage: verify.mjs --self-check [targets.json] | verify --targets <targets.json> --target <name> --candidate <file> [--holder <file>] [--out <final.json>]');
  process.exit(2);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2));
}
