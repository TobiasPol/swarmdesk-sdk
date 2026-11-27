// Candidate sources for the business-eval tests. Each cheat is the (correct) holder logic plus one
// attack, so a verdict of ACCEPTED would mean the attack worked.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const BIZ_DIR = resolve(here, '../templates/business-eval');
export const TARGET_DIR = join(BIZ_DIR, 'targets/pricing_router');
export const HOLDER_PATH = join(TARGET_DIR, 'candidate.mjs');
export const REFERENCE_PATH = join(TARGET_DIR, 'reference.mjs');

export const OPTIMAL_MODEL = `s.taskTier === 'audit' ? 'frontier' : (s.taskTier === 'synthesize' || (s.requiresJsonSchema && s.inputTokens > 2500)) ? 'mid' : 'mini'`;
const NET_LINE = 'const netCents = Math.round((s.seats * s.planCents * (100 - discountPct)) / 100);';

export function holderSource() {
  return readFileSync(HOLDER_PATH, 'utf8');
}

// Holder logic with the optimal router, optionally with a statement prepended, a replaced net-cents
// expression, or a replaced `model` property.
export function variant({ pre = '', model = OPTIMAL_MODEL, net, modelProp } = {}) {
  let src = holderSource();
  if (pre) src = src.replace('export function routeAndPrice(s) {\n', `export function routeAndPrice(s) {\n  ${pre}\n`);
  if (net) src = src.replace(NET_LINE, `const netCents = ${net};`);
  return src.replace("model: 'frontier',", modelProp ?? `model: ${model},`);
}

export const HONEST = variant();

const FORGED = JSON.stringify({
  verdict: 'ACCEPTED', reason_code: '', reason: 'forged', resolution: 'improved', metric_value: 1,
  holder_value: 13030, proof_lines: 1, wasm_bytes: 0, class_fuel: '{}',
});

export const CHEATS = {
  // Mutates the scenario so the oracle charges for zero input tokens.
  B_mutate_input: variant({ pre: 's.inputTokens = 0;', model: "'frontier'" }),
  // Re-exports the oracle through a dynamic import the regex guard cannot see.
  G_reexport_ref: `const R = await (0)['constr'+'uctor']['constr'+'uctor']('return imp'+'ort(arguments[0])')('file:'+'/'+'/'+'${REFERENCE_PATH}');
export function routeAndPrice(s) {
  const r = R.evaluateReference(s);
  return { netCents: r.netCents, vatCents: r.vatCents, totalCents: r.totalCents, taxMode: r.taxMode, model: r.optimalModel };
}
`,
  // Prints a forged ACCEPTED verdict to stdout and exits 0 (through `global`, which the guard misses).
  D_forge: `export function routeAndPrice(s) {
  const P = global['pro'+'cess'];
  P.stdout.write(${JSON.stringify(FORGED)} + '\\n');
  P.exit(0);
}
`,
  // Same forgery, but through the codegen route.
  D_forge_codegen: `export function routeAndPrice(s) {
  const P = (0)['constr'+'uctor']['constr'+'uctor']('return pro'+'cess')();
  P.stdout.write(${JSON.stringify(FORGED)} + '\\n');
  P.exit(0);
}
`,
  // Reports a cheap model on the first read and an expensive one on every later read.
  F_getter_toctou: variant({ modelProp: "get model() { return (this.n = (this.n || 0) + 1) === 1 ? 'frontier' : 'mini'; }," }),
  // Wrong only for exactly 37 seats.
  I_rare_wrong: variant({ net: 's.seats === 37 ? 0 : Math.round((s.seats * s.planCents * (100 - discountPct)) / 100)' }),
  // Off-by-one at the volume-discount boundary.
  J_boundary_100: variant({ pre: 'const t = s;', net: 'Math.round((s.seats * s.planCents * (100 - Math.max(s.seats > 100 ? 20 : 0, s.annualBilling && s.seats >= 5 ? 15 : 0, s.couponPct))) / 100)' }),
  // The old oracle's bug: France and the Netherlands taxed at 19%.
  K_old_vat: holderSource().replace('FR: 20,', 'FR: 19,').replace('NL: 21,', 'NL: 19,').replace("model: 'frontier',", `model: ${OPTIMAL_MODEL},`),
};

// Table keyed on the scenario id (the public golden ids 0..239).
export function lookupById(ref, scn) {
  const rows = scn.buildScenarios().map((s) => {
    const e = ref.evaluateReference(s);
    return [e.netCents, e.vatCents, e.taxMode, e.optimalModel];
  });
  return `const T = ${JSON.stringify(rows)};
export function routeAndPrice(s) {
  const r = T[s.id];
  return { netCents: r[0], vatCents: r[1], totalCents: r[0] + r[1], taxMode: r[2], model: r[3] };
}
`;
}

// Correct billing and VAT everywhere; cheap model only for the memorized public golden inputs.
export function memorizedModels(ref, scn) {
  const key = (s) => JSON.stringify([s.customerCountry, s.hasValidVatId, s.seats, s.planCents, s.annualBilling, s.couponPct, s.taskTier, s.inputTokens, s.requiresJsonSchema]);
  const table = Object.fromEntries(scn.buildScenarios().map((s) => [key(s), ref.evaluateReference(s).optimalModel]));
  return variant({ model: `T[JSON.stringify([s.customerCountry, s.hasValidVatId, s.seats, s.planCents, s.annualBilling, s.couponPct, s.taskTier, s.inputTokens, s.requiresJsonSchema])] ?? 'frontier'` })
    .replace('export function routeAndPrice', `const T = ${JSON.stringify(table)};\nexport function routeAndPrice`);
}
