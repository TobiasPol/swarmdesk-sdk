const EU_RATES = {
  AT: 20, BE: 21, BG: 20, CY: 19, CZ: 21, DK: 25, EE: 24, ES: 21, FI: 25.5,
  FR: 20, GR: 24, HR: 25, HU: 27, IE: 23, IT: 22, LT: 21, LU: 17, LV: 21, MT: 18,
  NL: 21, PL: 23, PT: 23, RO: 21, SE: 25, SI: 22, SK: 23,
};
const NON_EU = ['US', 'CH', 'GB', 'NO', 'CA', 'AU'];

function tax(country, hasValidVatId, netCents) {
  if (country === 'DE') return { taxMode: 'DE_19', vatCents: Math.round((netCents * 19) / 100) };
  if (Object.hasOwn(EU_RATES, country)) {
    if (hasValidVatId) return { taxMode: 'EU_REVERSE_CHARGE', vatCents: 0 };
    return { taxMode: 'EU_OSS', vatCents: Math.round((netCents * EU_RATES[country]) / 100) };
  }
  if (NON_EU.includes(country)) return { taxMode: 'NON_EU_EXPORT', vatCents: 0 };
  throw new RangeError('unsupported customerCountry');
}

export function routeAndPrice(s) {
  const annualPct = s.annualBilling && s.seats >= 5 ? 15 : 0;
  const volumeFloor = s.seats >= 100 ? 20 : 0;
  const discountPct = Math.max(volumeFloor, annualPct, s.couponPct);
  const netCents = Math.round((s.seats * s.planCents * (100 - discountPct)) / 100);
  const { taxMode, vatCents } = tax(s.customerCountry, s.hasValidVatId, netCents);
  return {
    netCents,
    vatCents,
    totalCents: netCents + vatCents,
    taxMode,
    model: 'frontier',
  };
}
