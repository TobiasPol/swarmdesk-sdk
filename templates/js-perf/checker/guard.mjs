// Verdict shape and the cheap source guard for js-perf candidates. Trusted code, verifier process only.
// The guard is a first filter; the security boundary is the sandbox (see sandbox.mjs).

export const DEFAULT_MAX_BYTES = 65536;

const FORBIDDEN_PATTERNS = [
  [/\/\//, 'single-line comments are not allowed'],
  [/\/\*/, 'block comments are not allowed'],
  [/\bimport\b/, 'import statements are not allowed'],
  [/\brequire\s*\(/, 'require() is not allowed'],
  [/\beval\s*\(/, 'eval() is not allowed'],
  [/\bFunction\s*\(/, 'Function constructor is not allowed'],
  [/\bconstructor\b/, 'constructor access is not allowed'],
  [/\bprocess\b/, 'process access is not allowed'],
  [/\bglobalThis\b/, 'globalThis access is not allowed'],
  [/\bProxy\b/, 'Proxy is not allowed'],
  [/__proto__/, '__proto__ access is not allowed'],
  [/\bReflect\b/, 'Reflect is not allowed'],
  [/\bfetch\s*\(/, 'network calls are not allowed'],
];

export const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export function rejected(reasonCode, reason, extra = {}) {
  return {
    verdict: 'REJECTED',
    reason_code: reasonCode,
    reason,
    resolution: '',
    metric_value: extra.metric_value ?? null,
    holder_value: extra.holder_value ?? null,
    proof_lines: 0,
    wasm_bytes: 0,
    class_fuel: extra.class_fuel ?? '{}',
  };
}

// exportName comes from targets.json (maintainer-written) and is checked to be a plain identifier.
export function guardCandidateSource(rawText, maxBytes = DEFAULT_MAX_BYTES, exportName = 'jsonEscape') {
  if (!IDENTIFIER.test(exportName)) return rejected('fault', 'target has an invalid export name');
  if (typeof rawText !== 'string' || rawText.trim().length === 0) {
    return rejected('schema_error', 'submission file is empty');
  }
  if (Buffer.byteLength(rawText, 'utf8') > maxBytes) {
    return rejected('size_limit', `submission exceeds ${maxBytes} bytes`);
  }
  if (rawText.includes('\0') || rawText.charCodeAt(0) === 0xfeff) {
    return rejected('guard_rejected', 'submission contains invalid control bytes');
  }
  for (const [pattern, message] of FORBIDDEN_PATTERNS) {
    if (pattern.test(rawText)) return rejected('guard_rejected', message);
  }
  if (!new RegExp(`export\\s+function\\s+${exportName.replaceAll('$', '\\$')}\\s*\\(`).test(rawText)) {
    return rejected('schema_error', `candidate must export function ${exportName}`);
  }
  return null;
}
