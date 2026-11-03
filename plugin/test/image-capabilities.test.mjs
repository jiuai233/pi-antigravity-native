import assert from 'node:assert/strict';
import test from 'node:test';
import { capabilitiesForModel, toProviderModel } from '../src/provider/models.ts';

test('Gemini and Claude catalog families advertise native image input', () => {
  for (const id of ['gemini-fixture', 'claude-fixture']) {
    assert.deepEqual(capabilitiesForModel(id).input, ['text', 'image']);
  }
});

test('the actual provider registration projection delivers the declared modalities', () => {
  for (const id of ['gemini-fixture', 'claude-fixture', 'gpt-oss-120b']) {
    const model = toProviderModel({ id, name: 'Fixture', supportedEfforts: [] });
    assert.equal(model.id, id);
    assert.equal(model.name, 'Fixture');
    assert.deepEqual(model.input, capabilitiesForModel(id).input);
    assert.ok(model.contextWindow > 0 && model.maxTokens > 0);
  }
});

test('text-only and unknown model families do not inherit image support', () => {
  assert.deepEqual(capabilitiesForModel('gpt-oss-120b').input, ['text']);
  assert.deepEqual(capabilitiesForModel('unknown-fixture').input, ['text']);
});
