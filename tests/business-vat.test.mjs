import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { routeAndPrice } from '../templates/business-eval/targets/pricing_router/candidate.mjs';
import { REFERENCE_PATH } from './business-fixtures.mjs';

const ref = await import(pathToFileURL(REFERENCE_PATH).href);
const scn = await import(pathToFileURL(REFERENCE_PATH.replace('reference', 'scenarios')).href);

const base = {
  customerCountry: 'DE', hasValidVatId: false, seats: 10, planCents: 10000, annualBilling: false,
  couponPct: 0, taskTier: 'extract', inputTokens: 100, requiresJsonSchema: false,
};
const price = (over) => ref.evaluateReference({ ...base, ...over });

test('Germany is taxed at 19% for B2C and B2B alike', () => {
  for (const hasValidVatId of [false, true]) {
    const r = price({ customerCountry: 'DE', hasValidVatId });
    assert.equal(r.taxMode, 'DE_19');
    assert.equal(r.netCents, 100000);
    assert.equal(r.vatCents, 19000);
  }
});

test('B2C in other EU countries pays that country\'s standard rate (OSS): FR 20, NL 21, ES 21, FI 25.5, HU 27', () => {
  const expected = { FR: 20000, NL: 21000, ES: 21000, FI: 25500, HU: 27000, LU: 17000 };
  for (const [customerCountry, vatCents] of Object.entries(expected)) {
    const r = price({ customerCountry });
    assert.equal(r.taxMode, 'EU_OSS', customerCountry);
    assert.equal(r.vatCents, vatCents, customerCountry);
    assert.equal(r.totalCents, 100000 + vatCents);
  }
});

test('other EU country with a valid VAT ID is reverse charge with zero VAT', () => {
  for (const customerCountry of ['FR', 'NL', 'ES', 'PL']) {
    const r = price({ customerCountry, hasValidVatId: true });
    assert.equal(r.taxMode, 'EU_REVERSE_CHARGE');
    assert.equal(r.vatCents, 0);
  }
});

test('non-EU countries are exports; the VAT ID is irrelevant', () => {
  for (const customerCountry of ['US', 'CH', 'GB']) {
    for (const hasValidVatId of [false, true]) {
      const r = price({ customerCountry, hasValidVatId });
      assert.equal(r.taxMode, 'NON_EU_EXPORT');
      assert.equal(r.vatCents, 0);
    }
  }
});

test('unknown country codes throw instead of defaulting to 0%', () => {
  for (const customerCountry of ['XX', 'de', '', 'toString', '__proto__', undefined, 49]) {
    assert.throws(() => price({ customerCountry }), /customerCountry/, String(customerCountry));
  }
  assert.throws(() => ref.taxFor('XX', false, 100), RangeError);
});

test('invalid seats, coupons and flags are rejected', () => {
  for (const seats of [0, -1, 1.5, '3', null, Number.NaN]) assert.throws(() => price({ seats }), /seats/);
  for (const couponPct of [-1, 101, 10.5, '10']) assert.throws(() => price({ couponPct }), /couponPct/);
  assert.throws(() => price({ hasValidVatId: 'yes' }), /hasValidVatId/);
  assert.throws(() => price({ taskTier: 'constructor' }), /taskTier/);
  assert.equal(price({ couponPct: 100 }).netCents, 0);
});

test('the holder candidate computes the oracle\'s billing for every supported country and boundary', () => {
  const fresh = scn.buildFreshScenarios(7);
  assert.equal(new Set(fresh.map((s) => s.customerCountry)).size, ref.SUPPORTED_COUNTRIES.length);
  for (const seats of [1, 4, 5, 99, 100, 101]) assert.ok(fresh.some((s) => s.seats === seats));
  for (const couponPct of [0, 100]) assert.ok(fresh.some((s) => s.couponPct === couponPct));
  assert.ok(fresh.some((s) => s.hasValidVatId) && fresh.some((s) => !s.hasValidVatId));
  for (const { id: _id, ...s } of [...scn.buildScenarios(), ...fresh]) {
    const want = ref.evaluateReference(s);
    const got = routeAndPrice(s);
    assert.deepEqual(
      [got.netCents, got.vatCents, got.totalCents, got.taxMode],
      [want.netCents, want.vatCents, want.totalCents, want.taxMode],
    );
  }
});

test('verifyDecision demands the exact schema and reads each field once', () => {
  const s = { ...base };
  const good = { netCents: 100000, vatCents: 19000, totalCents: 119000, taxMode: 'DE_19', model: 'mini' };
  assert.equal(ref.verifyDecision(s, good).ok, true);
  assert.equal(ref.verifyDecision(s, { ...good, extra: 1 }).ok, false);
  assert.equal(ref.verifyDecision(s, { ...good, vatCents: '19000' }).ok, false);
  assert.equal(ref.verifyDecision(s, { ...good, model: 'toString' }).ok, false);
  assert.equal(ref.verifyDecision(s, { ...good, taxMode: 'EU_VAT_19' }).ok, false);
  let reads = 0;
  const getter = { ...good };
  Object.defineProperty(getter, 'model', { enumerable: true, get() { reads += 1; return 'mini'; } });
  ref.verifyDecision(s, getter);
  assert.equal(reads, 1);
});
