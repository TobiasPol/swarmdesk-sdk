export const MODEL_SPECS = Object.freeze({
  mini: { quality: 1, fixedCost: 1, per1kTokens: 2 },
  mid: { quality: 2, fixedCost: 2, per1kTokens: 6 },
  frontier: { quality: 3, fixedCost: 4, per1kTokens: 24 },
});

const TIER_FLOOR = Object.freeze({
  extract: 1,
  classify: 1,
  synthesize: 2,
  audit: 3,
});

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildScenarios(seed = 20261127) {
  const rng = mulberry32(seed);
  const countries = ['DE', 'FR', 'NL', 'US', 'CH'];
  const tiers = ['extract', 'classify', 'synthesize', 'audit'];
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
      customerCountry: countries[Math.floor(rng() * countries.length)],
      hasValidVatId: rng() > 0.45,
      seats: [1, 3, 5, 12, 40, 100, 250][Math.floor(rng() * 7)],
      planCents: plans[Math.floor(rng() * plans.length)],
      annualBilling: rng() > 0.5,
      couponPct: coupons[Math.floor(rng() * coupons.length)],
      taskTier: tiers[Math.floor(rng() * tiers.length)],
      inputTokens: 250 + Math.floor(rng() * 3600),
      requiresJsonSchema: rng() > 0.5,
    });
  }
  return out;
}

export function requiredQualityFloor(scenario) {
  let floor = TIER_FLOOR[scenario.taskTier];
  if (scenario.requiresJsonSchema && scenario.inputTokens > 2500 && floor < 2) {
    floor = 2;
  }
  return floor;
}

export function evaluateReference(s) {
  const annualPct = s.annualBilling && s.seats >= 5 ? 15 : 0;
  const volumeFloor = s.seats >= 100 ? 20 : 0;
  const discountPct = Math.max(volumeFloor, annualPct, s.couponPct);
  const netCents = Math.round((s.seats * s.planCents * (100 - discountPct)) / 100);
  let taxMode = 'NON_EU_EXPORT';
  let vatCents = 0;
  if (s.customerCountry === 'DE') {
    taxMode = 'DE_19';
    vatCents = Math.round((netCents * 19) / 100);
  } else if (s.customerCountry === 'FR' || s.customerCountry === 'NL') {
    if (s.hasValidVatId) {
      taxMode = 'EU_REVERSE_CHARGE';
      vatCents = 0;
    } else {
      taxMode = 'EU_VAT_19';
      vatCents = Math.round((netCents * 19) / 100);
    }
  }
  const floor = requiredQualityFloor(s);
  const model = floor <= 1 ? 'mini' : floor === 2 ? 'mid' : 'frontier';
  return {
    netCents,
    vatCents,
    totalCents: netCents + vatCents,
    taxMode,
    minQualityFloor: floor,
    optimalModel: model,
  };
}

export function scoreScenarioCost(scenario, model) {
  const spec = MODEL_SPECS[model];
  if (!spec) {
    throw new Error(`unknown model: ${model}`);
  }
  return spec.fixedCost + Math.ceil((scenario.inputTokens * spec.per1kTokens) / 1000);
}

export function verifyDecision(scenario, decision) {
  if (!decision || typeof decision !== 'object') {
    return { ok: false, reason: 'decision must be an object' };
  }
  const ref = evaluateReference(scenario);
  if (decision.netCents !== ref.netCents) {
    return { ok: false, reason: `scenario ${scenario.id}: netCents ${decision.netCents} !== ${ref.netCents}` };
  }
  if (decision.vatCents !== ref.vatCents) {
    return { ok: false, reason: `scenario ${scenario.id}: vatCents ${decision.vatCents} !== ${ref.vatCents}` };
  }
  if (decision.totalCents !== ref.totalCents) {
    return { ok: false, reason: `scenario ${scenario.id}: totalCents ${decision.totalCents} !== ${ref.totalCents}` };
  }
  if (decision.taxMode !== ref.taxMode) {
    return { ok: false, reason: `scenario ${scenario.id}: taxMode ${decision.taxMode} !== ${ref.taxMode}` };
  }
  const spec = MODEL_SPECS[decision.model];
  if (!spec) {
    return { ok: false, reason: `scenario ${scenario.id}: invalid model ${decision.model}` };
  }
  if (spec.quality < ref.minQualityFloor) {
    return {
      ok: false,
      reason: `scenario ${scenario.id}: model ${decision.model} quality ${spec.quality} < SLA floor ${ref.minQualityFloor}`,
    };
  }
  return { ok: true, cost: scoreScenarioCost(scenario, decision.model) };
}
