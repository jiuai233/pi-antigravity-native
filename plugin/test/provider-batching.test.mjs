import assert from 'node:assert/strict';
import test from 'node:test';
import { createAntigravityRuntime } from '../src/runtime/runtime.ts';
import { streamAntigravity } from '../src/provider/stream.ts';

import { AgyReplayStore } from '../src/provider/replay.ts';
import { agyIncompleteToolError } from '../src/input/prompt.ts';
import { fixture, memoryStream } from './offline-fixture.mjs';

function setup(activities, { fail, pending = false } = {}) {
  const replay = new AgyReplayStore();
  const requests = [];
  const f = fixture({
    latestUserPrompt: () => ({ prompt: 'fixture' }), piHistoryBootstrap: () => undefined,
    normalizeContext: context => context, getCurrentSystemPrompt: () => '',
    readAgyProcessProfile: () => ({}), resolveAgyModelEffort: () => undefined,
    resolveBridgeResultsFromContext: () => 0, calculateCost: () => {},
    createAssistantMessageEventStream: memoryStream,
    WRAPPER_TOOL_NAME: 'antigravity', agyIncompleteToolError,
    readNativeToolResult: (_conversation, step) => ({
      args: { AbsolutePath: `file-${step}.txt` }, output: `SAVED_NATIVE_RESULT_${step}`,
    }),
  });

  const outcome = { status: 'OK', response: 'Final native answer', conversationId: 'fixture-native',
    usage: { input_tokens: 2200, output_tokens: 50 } };
  const rt = createAntigravityRuntime(async request => {
    requests.push(request);
    request.onConversation('fixture-native');
    for (const activity of activities) request.onActivity(activity);
    if (fail) throw new Error(fail);
    if (pending) return new Promise(() => {});
    request.onActivity({ type: 'result', ...outcome });
    return outcome;
  }, undefined, f.childrenHost);
  const service = rt;
  const provider = streamAntigravity({ ...f.providerOptions, runtime: rt, replay,
    bridge: { refreshTools() {}, serverName: 'fixture' } });
  return {
    requests, replay, f,
    async next() {
      const stream = provider({ id: 'fixture', api: 'fixture', provider: 'antigravity' }, { messages: [] });
      await stream.ended;
      return stream.events.at(-1);
    },
    async close() { await service.close(); },
  };
}

const nativeRead = stepId => [
  { type: 'tool_start', name: 'view_file', stepId, args: { AbsolutePath: `file-${stepId}.txt` } },
  { type: 'tool_done', name: 'view_file', stepId, args: { AbsolutePath: `file-${stepId}.txt` }, output: 'CLI size summary' },
];

test('native reads share one Pi handoff without a second read, and usage remains per response', async () => {
  const fx = setup([
    { type: 'usage', usage: { input_tokens: 1000, output_tokens: 20 } },
    ...nativeRead(1), ...nativeRead(2),
    { type: 'usage', usage: { input_tokens: 1200, output_tokens: 30 } },
    { type: 'text', delta: 'Final native answer' },
  ]);
  try {
    const first = await fx.next();
    assert.equal(first.message.stopReason, 'toolUse');
    const calls = first.message.content.filter(part => part.type === 'toolCall');
    assert.deepEqual(Array.from(calls, call => call.name), ['antigravity', 'antigravity']);
    assert.deepEqual(Array.from(calls, call => fx.replay.take(call.id).output),
      ['SAVED_NATIVE_RESULT_1', 'SAVED_NATIVE_RESULT_2']);
    assert.equal(first.message.usage.input, 1000);
    const final = await fx.next();
    assert.equal(final.message.stopReason, 'stop');
    assert.equal(final.message.usage.input, 1200); // Not 2200 as a fictitious live context.
    assert.equal(first.message.usage.output + final.message.usage.output, 50);
    assert.equal(final.message.content.filter(part => part.type === 'text').map(part => part.text).join(''), 'Final native answer');
    assert.equal(fx.requests.length, 1);
    assert.equal(fx.replay.size, 0);
  } finally { await fx.close(); }
});

test('real Pi bridge call hands off immediately alongside already-recorded native cards', { timeout: 2000 }, async () => {
  const fx = setup([
    ...nativeRead(1), ...nativeRead(2),
    { type: 'bridge_call', id: 'pi-real-call', name: 'read', args: { path: 'requested-by-model.txt' } },
  ], { pending: true });
  try {
    const first = await fx.next();
    assert.equal(first.message.stopReason, 'toolUse');
    const calls = first.message.content.filter(part => part.type === 'toolCall');
    assert.deepEqual(Array.from(calls, call => call.name), ['antigravity', 'antigravity', 'read']);
    assert.equal(calls.at(-1).id, 'pi-real-call');
    assert.equal(fx.requests.length, 1);
  } finally { await fx.close(); }
});

test('executor failure still delivers completed native cards before surfacing its error', async () => {
  const fx = setup(nativeRead(1), { fail: 'Original native stream failure' });
  try {
    const first = await fx.next();
    assert.equal(first.message.stopReason, 'toolUse');
    const call = first.message.content.find(part => part.type === 'toolCall');
    assert.equal(call.name, 'antigravity');
    assert.equal(fx.replay.take(call.id).output, 'SAVED_NATIVE_RESULT_1');
    const final = await fx.next();
    assert.equal(final.type, 'error');
    assert.equal(final.error.errorMessage, 'Original native stream failure');
    assert.equal(fx.requests.length, 1);
  } finally { await fx.close(); }
});
