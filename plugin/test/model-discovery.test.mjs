import assert from 'node:assert/strict';
import test from 'node:test';
import { ModelCatalog, modelDiscoveryFailure } from '../src/extension/model-catalog.ts';

function catalog(cached, listModels, { persist = true } = {}) {
  const writes = [];
  const io = {
    readCache: () => cached,
    writeCache: value => {
      if (!persist) throw new Error('fixture cache is read-only');
      writes.push(value);
    },
    listModels,
  };
  return { models: new ModelCatalog(io), writes };
}
const previous = () => ({ fetchedAt: 1, source: 'live', models: [
  { id: 'gemini-4-argon', name: 'Fixture cached model', supportedEfforts: [] },
] });

test('failed refresh preserves last live catalog, success time and original error', async () => {
  const error = Object.assign(new Error('fixture upstream EOF'), { code: 'fixture_eof', stderr: 'original diagnostic' });
  const cached = previous();
  const { models, writes } = catalog(cached, async () => { throw error; });
  const result = await models.refresh();
  assert.equal(result.source, 'live');
  assert.equal(result.fetchedAt, cached.fetchedAt);
  assert.equal(result.models[0].id, 'gemini-4-argon');
  assert.equal(result.discoveryError, error);
  assert.equal(result.discoveryError.stderr, 'original diagnostic');
  assert.match(modelDiscoveryFailure(result), /fixture upstream EOF/);
  assert.equal(models.cache, result);
  assert.equal(writes.length, 0);
});

test('first discovery failure returns usable fallback and exposes original exception', async () => {
  const error = new Error('fixture incompatible CLI');
  const { models, writes } = catalog(null, async () => { throw error; });
  const result = await models.refresh();
  assert.equal(result.source, 'fallback');
  assert.ok(result.models.length > 0);
  assert.equal(result.fetchedAt, 0);
  assert.equal(result.discoveryError, error);
  assert.equal(writes.length, 0);
});

test('empty/unparseable discovery preserves live models; success replaces and persists them', async () => {
  let output = 'not a model row';
  const { models, writes } = catalog(previous(), async () => output);
  const failed = await models.refresh();
  assert.equal(failed.models[0].id, 'gemini-4-argon');
  assert.ok(failed.discoveryError instanceof Error);
  output = 'gemini-fixture\tFixture model\n';
  const live = await models.refresh();
  assert.equal(live.source, 'live');
  assert.equal(live.models[0].id, 'gemini-fixture');
  assert.equal(live.discoveryError, undefined);
  assert.ok(live.fetchedAt > failed.fetchedAt);
  assert.equal(writes[0], live);
  assert.equal(models.find('gemini-fixture'), live.models[0]);
});

test('failed refresh also retains in-memory live results when cache persistence is unavailable', async () => {
  const error = new Error('fixture command failed');
  let fail = false;
  const { models, writes } = catalog(null, async () => {
    if (fail) throw error;
    return 'gemini-fixture\tFixture model\n';
  }, { persist: false });
  const live = await models.refresh();
  assert.equal(live.source, 'live');
  fail = true;
  const result = await models.refresh();
  assert.equal(result.models, live.models);
  assert.equal(result.fetchedAt, live.fetchedAt);
  assert.equal(result.discoveryError, error);
  assert.equal(writes.length, 0);
});

test('a refresh that fails falls back to the catalog it started from, even if another refresh finished meanwhile', async () => {
  const pending = [];
  const { models } = catalog(previous(), () => new Promise((resolve, reject) => pending.push({ resolve, reject })));
  const first = models.refresh();
  const second = models.refresh();
  pending[1].resolve('gemini-fixture-a\tFixture A\ngemini-fixture-b\tFixture B\n');
  const live = await second;
  assert.deepEqual(live.models.map(model => model.id).sort(), ['gemini-fixture-a', 'gemini-fixture-b']);
  const error = new Error('fixture late failure');
  pending[0].reject(error);
  const failed = await first;
  assert.deepEqual(failed.models.map(model => model.id), ['gemini-4-argon']);
  assert.equal(failed.fetchedAt, 1);
  assert.equal(failed.discoveryError, error);
  assert.match(modelDiscoveryFailure(failed), /using 1 last-known-good live models/);
  assert.equal(models.cache, failed);
});

test('a live catalog within its TTL skips re-discovery; the fallback never counts as fresh', () => {
  assert.equal(catalog({ ...previous(), fetchedAt: Date.now() }).models.isFresh(), true);
  assert.equal(catalog(null).models.isFresh(), false);
});
