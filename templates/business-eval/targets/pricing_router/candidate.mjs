export function routeAndPrice(s) {
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
  return {
    netCents,
    vatCents,
    totalCents: netCents + vatCents,
    taxMode,
    model: 'frontier',
  };
}
