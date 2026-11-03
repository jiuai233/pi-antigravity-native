
import assert from 'node:assert/strict';
import test from 'node:test';
import { mapUsage } from '../src/provider/mapping.ts';
import { agyContextTokens } from '../src/native/agy-compaction.ts';

test('Pi total includes cached input without changing native usage or billing components', () => {
  const native = { input_tokens: 2382, output_tokens: 187, thinking_tokens: 72,
    cache_read_tokens: 4537, total_tokens: 2569 };
  const original = structuredClone(native);
  const usage = mapUsage(native);
  assert.equal(usage.totalTokens, 7106);
  assert.deepEqual([usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.reasoning],
    [2382, 187, 4537, 0, 72]);
  assert.equal(agyContextTokens(native), 6919);
  assert.deepEqual(native, original);
});

test('uncached and missing usage keep their normal totals', () => {
  assert.equal(mapUsage({ input_tokens: 100, output_tokens: 20,
    thinking_tokens: 10, total_tokens: 120 }).totalTokens, 120);
  const empty = mapUsage(undefined);
  assert.equal(empty.totalTokens, 0);
  assert.deepEqual([empty.input, empty.output, empty.cacheRead, empty.cacheWrite], [0, 0, 0, 0]);
});
