// Scenario generators for the pricing_router target. Trusted code, verifier process only.
// Golden scenarios are fixed (seed 20261127) and public. Fresh scenarios are generated per run from
// a random seed that the verdict records, and always include the boundary values.
import { SUPPORTED_COUNTRIES, TASK_TIERS } from './reference.mjs';

export const GOLDEN_SEED = 20261127;
export const BOUNDARY_SEATS = Object.freeze([1, 4, 5, 99, 100, 101]);
export const BOUNDARY_COUPONS = Object.freeze([0, 100]);

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (rng, list) => list[Math.floor(rng() * list.length)];
const between = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));

export function buildScenarios(seed = GOLDEN_SEED) {
  const rng = mulberry32(seed);
  const countries = ['DE', 'FR', 'NL', 'ES', 'IT', 'AT', 'PL', 'US', 'CH'];
  const coupons = [0, 0, 10, 20];
  const plans = [1900, 2900, 4900, 9900];
  const fixed = [
    { customerCountry: 'DE', hasValidVatId: true, seats: 3, planCents: 2900, annualBilling: true, couponPct: 0, taskTier: 'extract', inputTokens: 800, requiresJsonSchema: false },
    { customerCountry: 'FR', hasValidVatId: true, seats: 25, planCents: 4900, annualBilling: true, couponPct: 10, taskTier: 'classify', inputTokens: 1600, requiresJsonSchema: true },
    { customerCountry: 'NL', hasValidVatId: false, seats: 120, planCents: 9900, annualBilling: false, couponPct: 10, taskTier: 'synthesize', inputTokens: 3200, requiresJsonSchema: true },
    { customerCountry: 'US', hasValidVatId: false, seats: 10, planCents: 2900, annualBilling: false, couponPct: 20, taskTier: 'audit', inputTokens: 2400, requiresJsonSchema: true },
    { customerCountry: 'CH', hasValidVatId: false, seats: 2, planCents: 1900, annualBilling: false, couponPct: 0, taskTier: 'extract', inputTokens: 3100, requiresJsonSchema: true },
  ];
  const out = fixed.map((s, id) => ({ id, ...s }));
  for (let i = fixed.length; i < 240; i += 1) {
    out.push({
      id: i,
      customerCountry: pick(rng, countries),
      hasValidVatId: rng() > 0.45,
      seats: pick(rng, [1, 3, 5, 12, 40, 100, 250]),
      planCents: pick(rng, plans),
      annualBilling: rng() > 0.5,
      couponPct: pick(rng, coupons),
      taskTier: pick(rng, TASK_TIERS),
      inputTokens: 250 + Math.floor(rng() * 3600),
      requiresJsonSchema: rng() > 0.5,
    });
  }
  return out;
}

// 1. Every supported country x with/without VAT ID x boundary seats x annual billing x coupon 0/100.
// 2. A sweep that hits every seat count 1..SWEEP_MAX and every coupon 0..100 at least once.
// 3. `randomCount` unconstrained rows.
// Plan prices, tiers and token counts are random everywhere, so nothing can be tabulated in advance.
export const SWEEP_MAX = 300;

export function buildFreshScenarios(seed, randomCount = 300) {
  const rng = mulberry32(seed);
  const out = [];
  const row = (extra) => ({
    planCents: between(rng, 100, 30000),
    taskTier: pick(rng, TASK_TIERS),
    inputTokens: pick(rng, [between(rng, 100, 4000), 2499, 2500, 2501]),
    requiresJsonSchema: rng() > 0.5,
    ...extra,
  });
  for (const customerCountry of SUPPORTED_COUNTRIES) {
    for (const hasValidVatId of [false, true]) {
      for (const seats of BOUNDARY_SEATS) {
        for (const annualBilling of [false, true]) {
          for (const couponPct of BOUNDARY_COUPONS) {
            out.push(row({ customerCountry, hasValidVatId, seats, annualBilling, couponPct }));
          }
        }
      }
    }
  }
  for (let seats = 1; seats <= SWEEP_MAX; seats += 1) {
    out.push(row({
      customerCountry: SUPPORTED_COUNTRIES[seats % SUPPORTED_COUNTRIES.length],
      hasValidVatId: rng() > 0.5,
      seats,
      annualBilling: rng() > 0.5,
      couponPct: seats % 101,
    }));
  }
  for (let i = 0; i < randomCount; i += 1) {
    out.push(row({
      customerCountry: pick(rng, SUPPORTED_COUNTRIES),
      hasValidVatId: rng() > 0.5,
      seats: rng() > 0.5 ? pick(rng, BOUNDARY_SEATS) : between(rng, 1, 400),
      annualBilling: rng() > 0.5,
      couponPct: between(rng, 0, 100),
    }));
  }
  return out.map((s, i) => ({ id: 100000 + i, ...s }));
}
