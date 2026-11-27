// Frozen oracle for the pricing_router target: discount rules, VAT treatment and the LLM quality SLA.
// Trusted code. It runs in the verifier process only and is never visible to the candidate.

export const MODEL_SPECS = Object.freeze({
  mini: { quality: 1, fixedCost: 1, per1kTokens: 2 },
  mid: { quality: 2, fixedCost: 2, per1kTokens: 6 },
  frontier: { quality: 3, fixedCost: 4, per1kTokens: 24 },
});

const TIER_FLOOR = Object.freeze({ extract: 1, classify: 1, synthesize: 2, audit: 3 });
export const TASK_TIERS = Object.freeze(Object.keys(TIER_FLOOR));

// Seller is established in Germany: domestic supplies are always taxed at the German rate.
export const SELLER_COUNTRY = 'DE';

// Standard VAT rates in percent, ISO 3166-1 alpha-2 codes (Greece is GR here, EL in VAT numbers).
// Source (official): "VAT rules and rates", Your Europe, European Commission / europa.eu, page marked
//   "Last checked: 13/07/2026", read on 2026-11-27:
//   https://europa.eu/youreurope/business/taxation/vat/vat-rules-rates/index_en.htm
// It lists the standard rate of all 27 Member States (it uses EL for Greece). The European Commission's
// "VAT rates" page (https://taxation-customs.ec.europa.eu/taxation/vat/vat-rates_en) tabulates no
// figures itself and points to the Member-State-reported Taxes in Europe Database (TEDB). The values
// were cross-checked against https://en.wikipedia.org/wiki/European_Union_value_added_tax
// (revision of 2026-10-22) and the post-2024 changes (FI 25.5% from 2024-09-01, SK 23% from
// 2025-01-01, EE 24% from 2025-07-01, RO 21% from 2025-08-01). Re-verify against TEDB before using
// this table for real invoices. Reduced rates, special territories (Canary Islands, Madeira, Azores,
// ...) and OSS thresholds are deliberately not modelled.
export const EU_STANDARD_RATES = Object.freeze({
  AT: 20, BE: 21, BG: 20, CY: 19, CZ: 21, DE: 19, DK: 25, EE: 24, ES: 21, FI: 25.5,
  FR: 20, GR: 24, HR: 25, HU: 27, IE: 23, IT: 22, LT: 21, LU: 17, LV: 21, MT: 18,
  NL: 21, PL: 23, PT: 23, RO: 21, SE: 25, SI: 22, SK: 23,
});

// Third countries: supplies are exports, no German or OSS VAT.
export const NON_EU_COUNTRIES = Object.freeze(['US', 'CH', 'GB', 'NO', 'CA', 'AU']);
export const SUPPORTED_COUNTRIES = Object.freeze([
  ...Object.keys(EU_STANDARD_RATES),
  ...NON_EU_COUNTRIES,
]);

const isInt = (v, min, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && v >= min && v <= max;

export function assertScenario(s) {
  if (!s || typeof s !== 'object') throw new TypeError('scenario must be an object');
  if (typeof s.customerCountry !== 'string' || !SUPPORTED_COUNTRIES.includes(s.customerCountry)) {
    throw new RangeError('unsupported customerCountry');
  }
  if (!isInt(s.seats, 1)) throw new RangeError('seats must be an integer >= 1');
  if (!isInt(s.couponPct, 0, 100)) throw new RangeError('couponPct must be an integer in 0..100');
  if (!isInt(s.planCents, 0)) throw new RangeError('planCents must be a non-negative integer');
  if (!isInt(s.inputTokens, 0)) throw new RangeError('inputTokens must be a non-negative integer');
  for (const key of ['hasValidVatId', 'annualBilling', 'requiresJsonSchema']) {
    if (typeof s[key] !== 'boolean') throw new TypeError(`${key} must be a boolean`);
  }
  if (!Object.hasOwn(TIER_FLOOR, s.taskTier)) throw new RangeError('unknown taskTier');
}

// DE: 19% domestic (B2B and B2C). Other EU + valid VAT ID: reverse charge. Other EU without one:
// that country's standard rate (OSS). Anything else supported: export, 0%. Unknown countries throw.
export function taxFor(country, hasValidVatId, netCents) {
  if (country === SELLER_COUNTRY) {
    return { taxMode: 'DE_19', vatCents: Math.round((netCents * EU_STANDARD_RATES.DE) / 100) };
  }
  if (Object.hasOwn(EU_STANDARD_RATES, country)) {
    if (hasValidVatId) return { taxMode: 'EU_REVERSE_CHARGE', vatCents: 0 };
    return { taxMode: 'EU_OSS', vatCents: Math.round((netCents * EU_STANDARD_RATES[country]) / 100) };
  }
  if (NON_EU_COUNTRIES.includes(country)) return { taxMode: 'NON_EU_EXPORT', vatCents: 0 };
  throw new RangeError('unsupported customerCountry');
}

export function requiredQualityFloor(scenario) {
  let floor = TIER_FLOOR[scenario.taskTier];
  if (scenario.requiresJsonSchema && scenario.inputTokens > 2500 && floor < 2) floor = 2;
  return floor;
}

export function evaluateReference(s) {
  assertScenario(s);
  const annualPct = s.annualBilling && s.seats >= 5 ? 15 : 0;
  const volumeFloor = s.seats >= 100 ? 20 : 0;
  const discountPct = Math.max(volumeFloor, annualPct, s.couponPct);
  const netCents = Math.round((s.seats * s.planCents * (100 - discountPct)) / 100);
  const { taxMode, vatCents } = taxFor(s.customerCountry, s.hasValidVatId, netCents);
  const floor = requiredQualityFloor(s);
  const model = floor <= 1 ? 'mini' : floor === 2 ? 'mid' : 'frontier';
  return { netCents, vatCents, totalCents: netCents + vatCents, taxMode, minQualityFloor: floor, optimalModel: model };
}

export function scoreScenarioCost(scenario, model) {
  if (!Object.hasOwn(MODEL_SPECS, model)) throw new Error('unknown model');
  const spec = MODEL_SPECS[model];
  return spec.fixedCost + Math.ceil((scenario.inputTokens * spec.per1kTokens) / 1000);
}

const DECISION_KEYS = 'model,netCents,taxMode,totalCents,vatCents';
const TAX_MODES = ['DE_19', 'EU_OSS', 'EU_REVERSE_CHARGE', 'NON_EU_EXPORT'];

// `decision` is untrusted JSON parsed by the verifier. Diagnostics never echo candidate strings.
export function verifyDecision(scenario, decision) {
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) {
    return { ok: false, reason: 'decision must be an object' };
  }
  if (Object.keys(decision).sort().join(',') !== DECISION_KEYS) {
    return { ok: false, reason: `decision must have exactly the fields ${DECISION_KEYS}` };
  }
  const { netCents, vatCents, totalCents, taxMode, model } = decision;
  for (const [name, value] of [['netCents', netCents], ['vatCents', vatCents], ['totalCents', totalCents]]) {
    if (!Number.isSafeInteger(value)) return { ok: false, reason: `${name} must be an integer` };
  }
  if (typeof taxMode !== 'string' || !TAX_MODES.includes(taxMode)) return { ok: false, reason: 'taxMode is not a known mode' };
  if (typeof model !== 'string' || !Object.hasOwn(MODEL_SPECS, model)) return { ok: false, reason: 'model is not a known model' };
  const ref = evaluateReference(scenario);
  if (netCents !== ref.netCents) return { ok: false, reason: 'netCents differs from the oracle' };
  if (vatCents !== ref.vatCents) return { ok: false, reason: 'vatCents differs from the oracle' };
  if (totalCents !== ref.totalCents) return { ok: false, reason: 'totalCents differs from the oracle' };
  if (taxMode !== ref.taxMode) return { ok: false, reason: 'taxMode differs from the oracle' };
  if (MODEL_SPECS[model].quality < ref.minQualityFloor) {
    return { ok: false, reason: `model quality is below the SLA floor ${ref.minQualityFloor}` };
  }
  return { ok: true, cost: scoreScenarioCost(scenario, model) };
}
