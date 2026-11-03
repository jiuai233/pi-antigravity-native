import assert from 'node:assert/strict';
import test from 'node:test';
import { AGY_PI_SCHEDULING_CONTEXT_WINDOW, capabilitiesForModel, FALLBACK_MODELS, toProviderModel } from '../src/provider/models.ts';

test('AGY registrations match the 512K preset and the native GPT-OSS exception', () => {
  assert.equal(AGY_PI_SCHEDULING_CONTEXT_WINDOW, 512_000);
  const ids = new Set([...FALLBACK_MODELS.map(model => model.id), 'gemini-fixture', 'claude-fixture', 'gpt-oss-120b', 'unknown-fixture']);
  for (const id of ids) {
    const expected = /^gpt-oss-120b/i.test(id) ? 98_304 : 512_000;
    assert.equal(capabilitiesForModel(id).contextWindow, expected, id);
    assert.equal(toProviderModel({ id, name: id, supportedEfforts: [] }).contextWindow, expected, id);
  }
  assert.equal(capabilitiesForModel('gpt-oss-120b').maxTokens, 32_768);
});
