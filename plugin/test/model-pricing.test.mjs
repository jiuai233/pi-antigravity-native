import assert from 'node:assert/strict';
import test from 'node:test';
import { pricingForModel, toProviderModel } from '../src/provider/models.ts';

const october = Date.UTC(2026, 9, 22);

test('Argon reference pricing covers input, output and implicit cache with its published date change', () => {
  assert.deepEqual(pricingForModel('gemini-4-argon', october), { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0 });
  assert.deepEqual(pricingForModel('gemini-4-argon', Date.UTC(2026, 10, 30, 23, 59, 59)), { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0 });
  assert.deepEqual(pricingForModel('gemini-4-argon', Date.UTC(2026, 11, 1)), { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 0 });
});

test('Carbon uses the same published Standard rates and date change as Argon', () => {
  assert.deepEqual(pricingForModel('gemini-4-carbon', october), { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0 });
  assert.deepEqual(pricingForModel('gemini-4-carbon', Date.UTC(2026, 11, 1)), { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 0 });
  assert.deepEqual(toProviderModel({ id: 'gemini-4-carbon', name: 'Gemini 4 Carbon', supportedEfforts: [] }).cost, pricingForModel('gemini-4-carbon'));
});

test('current Claude 5.5 families use their own published cache and output rates', () => {
  assert.deepEqual(pricingForModel('claude-opus-5-5'), { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 });
  assert.deepEqual(pricingForModel('claude-sonnet-5-5'), { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 });
});

test('registered model costs drive the native calculator without changing recorded token quantities', () => {
  const model = toProviderModel({ id: 'gemini-4-argon', name: 'Gemini 4 Argon', supportedEfforts: [] });
  assert.deepEqual(model.cost, pricingForModel(model.id));
  const usage = { input: 311036, output: 40337, cacheRead: 8478844 };
  const rates = pricingForModel(model.id, october);
  const cost = (usage.input * rates.input + usage.output * rates.output + usage.cacheRead * rates.cacheRead) / 1_000_000;
  assert.ok(Math.abs(cost - 1.8733264) < 1e-10);
});
