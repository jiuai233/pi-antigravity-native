import assert from 'node:assert/strict';
import test from 'node:test';
import { tagNativeReplayResult } from '../src/provider/replay.ts';

test('native replay success and failure are not model-input boundaries', () => {
  const recorded = { agyTool: 'view_file', output: 'ORIGINAL_NATIVE_RESULT' };
  for (const details of [recorded, undefined]) {
    const marked = tagNativeReplayResult({ toolName: 'antigravity', details });
    assert.equal(marked.details.notificationBoundary, false);
    if (details) assert.equal(marked.details.output, details.output);
  }
  assert.equal(recorded.notificationBoundary, undefined);
});

test('real Pi tool replies remain usable input boundaries', () => {
  assert.equal(tagNativeReplayResult({ toolName: 'read', details: { path: 'sample.txt' } }), undefined);
});
