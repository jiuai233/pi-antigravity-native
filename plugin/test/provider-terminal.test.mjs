import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { createAntigravityRuntime } from '../src/runtime/runtime.ts';
import { AgyTurnController } from '../src/runtime/turn.ts';
import { streamAntigravity } from '../src/provider/stream.ts';

import { fixture, flush, memoryStream } from './offline-fixture.mjs';
import { registerWrapperTool } from '../src/extension/wrapper-tool.ts';

import { AgyReplayStore } from '../src/provider/replay.ts';
import { resolveAgyDataDirectory } from '../src/native/native-workspace.ts';

for (const status of ['ERROR', 'OK']) {
  test(`partial text plus ${status} terminal retains the actual completion status`, async () => {
    const f = fixture({
      latestUserPrompt: () => ({ prompt: 'fixture' }), piHistoryBootstrap: () => undefined,
      normalizeContext: context => context, getCurrentSystemPrompt: () => '',
      readAgyProcessProfile: () => ({}), resolveAgyModelEffort: () => undefined,
      resolveBridgeResultsFromContext: () => 0, calculateCost: () => {},
      createAssistantMessageEventStream: memoryStream,
    });
    const controller = new AgyTurnController('fixture');
    controller.push({ type: 'text', delta: 'Incomplete prefix...' });
    controller.push({ type: 'result', status, response: 'Incomplete prefix...',
      error: status === 'ERROR' ? 'stream was interrupted: fixture EOF' : undefined });
    controller.close();
    let settled = 0;
    const stream = streamAntigravity({ ...f.providerOptions,
      runtime: { beginStreamTurn: () => controller, finishTurn() {}, steerActiveTurn() {}, snapshot: () => ({}) },
      replay: {}, bridge: { refreshTools() {}, serverName: 'fixture' },
      onSettled: () => settled++, isActiveTool: () => false,
      createIsolatedRuntime: () => { throw new Error('Unexpected retry or isolated runtime'); },
    })({ id: 'fixture', api: 'fixture', provider: 'antigravity' }, { messages: [] }, {});
    await stream.ended;
    const terminal = stream.events.at(-1);
    assert.equal(terminal.type, status === 'ERROR' ? 'error' : 'done');
    const message = terminal.error ?? terminal.message;
    assert.equal(message.stopReason, status === 'ERROR' ? 'error' : 'stop');
    assert.equal(message.content.find(block => block.type === 'text').text, 'Incomplete prefix...');
    if (status === 'ERROR') assert.match(message.errorMessage, /fixture EOF/);
    assert.equal(settled, 1);
    assert.equal(message.diagnostics, undefined); // No observed effort: never invent one.
  });
}

test('provider persists native effort across a requested change and SDK thinkingLevel overwrite', async () => {
  const f = fixture({
    latestUserPrompt: () => ({ prompt: 'fixture' }), piHistoryBootstrap: () => undefined,
    normalizeContext: context => context, getCurrentSystemPrompt: () => '',
    readAgyProcessProfile: () => ({}),
    resolveAgyModelEffort: (_model, requested) => requested,
    resolveBridgeResultsFromContext: () => 0, calculateCost: () => {},
    createAssistantMessageEventStream: memoryStream,
  });

  const requests = [];
  let complete;
  const rt = createAntigravityRuntime(request => {
    requests.push(request);
    return new Promise(resolve => {
      complete = () => {
        const outcome = { status: 'OK', response: 'fixture done' };
        request.onActivity({ type: 'result', ...outcome });
        resolve(outcome);
      };
    });
  }, undefined, f.childrenHost);
  const service = rt;
  const provider = streamAntigravity({ ...f.providerOptions, runtime: rt, replay: {},
    bridge: { refreshTools() {}, serverName: 'fixture' } });
  const start = reasoning => provider(
    { id: 'fixture', api: 'fixture', provider: 'antigravity' }, { messages: [] }, { reasoning });
  const persisted = (stream, reasoning) => {
    const event = stream.events.at(-1);
    assert.equal(event.type, 'done');
    // Match streamAssistantResponse's final Object.assign, then session JSONL.
    return JSON.parse(JSON.stringify(Object.assign(event.message, { thinkingLevel: reasoning })));
  };
  try {
    const first = start('high');
    await flush();
    assert.equal(service.pushBridgeCall({ id: 'bridge-fixture', tool: 'fixture', args: {} }), true);
    await first.ended;
    const high = persisted(first, 'high');
    assert.equal(high.stopReason, 'toolUse');
    service.finishBridgeCall('bridge-fixture');

    const resumed = start('medium');
    await flush();
    assert.equal(requests.length, 1); // No new native request or interruption.
    assert.equal(requests[0].effort, 'high');
    complete();
    await resumed.ended;
    const stillHigh = persisted(resumed, 'medium');
    assert.equal(stillHigh.thinkingLevel, 'medium');
    assert.deepEqual(stillHigh.diagnostics, high.diagnostics);
    assert.deepEqual(stillHigh.diagnostics, [{
      type: 'antigravity_turn', details: { effectiveEffort: 'high' },
    }]);

    await flush();
    const fresh = start('medium');
    await flush();
    assert.equal(requests.length, 2);
    assert.equal(requests[1].effort, 'medium');
    complete();
    await fresh.ended;
    assert.deepEqual(persisted(fresh, 'medium').diagnostics, [{
      type: 'antigravity_turn', details: { effectiveEffort: 'medium' },
    }]);
  } finally {
    await service.close();
  }
});

for (const { internal, missing } of [{ internal: false }, { internal: true }, { internal: false, missing: true }]) {
  test(`provider ${missing ? 'labels unavailable native records without inventing a reread' : internal ? 'replays the original CLI output' : 'replays the requested ordinary-file range without rereading'}`, async () => {
    const cwd = path.join(os.tmpdir(), 'agy-provider-read-fixture');
    const file = internal
      ? path.join(resolveAgyDataDirectory(cwd), 'mcp', 'b12345678', 'edit.json')
      : path.join(cwd, 'history.txt');
    const f = fixture({
      latestUserPrompt: () => ({ prompt: 'fixture' }), piHistoryBootstrap: () => undefined,
      normalizeContext: context => context, getCurrentSystemPrompt: () => '',
      readAgyProcessProfile: () => ({}), resolveAgyModelEffort: () => undefined,
      resolveBridgeResultsFromContext: () => 0, calculateCost: () => {},
      createAssistantMessageEventStream: memoryStream,
      createAntigravityRuntime: () => { throw new Error('Unexpected isolated runtime'); },
      WRAPPER_TOOL_NAME: 'antigravity',
      readNativeToolResult: () => {
        if (missing) throw new Error('Fixture native record unavailable.');
        return { args, output: originalOutput };
      },
    });
    const controller = new AgyTurnController('fixture');
    const args = { AbsolutePath: file, StartLine: '24418', EndLine: '25085' };
    const originalOutput = internal
      ? `Showing lines 24418 to 25085\n${'cache payload line\n'.repeat(1500)}TAIL_REQUIRED_FOR_REPLAY`
      : 'Showing lines 24418 to 25085\n原生结果，不是首页。';
    // Real CLI 1.4.4 streams omit line bounds and return only a size summary.
    const streamedArgs = { AbsolutePath: file };
    controller.push({ type: 'tool_start', stepId: 1, name: 'view_file', args: streamedArgs });
    controller.push({ type: 'tool_done', stepId: 1, name: 'view_file', args: streamedArgs, output: '3 lines, 20843 bytes' });
    controller.push({ type: 'result', status: 'OK', response: '' });
    controller.close();
    const replay = new AgyReplayStore();
    const stream = streamAntigravity({ ...f.providerOptions,
      runtime: { beginStreamTurn: () => controller, finishTurn() {}, steerActiveTurn() {}, snapshot: () => ({ cwd, conversationId: 'fixture-conversation' }) },
      replay, bridge: { refreshTools() {}, serverName: 'fixture' },
    })({ id: 'fixture', api: 'fixture', provider: 'antigravity' }, { messages: [] }, {});
    await stream.ended;
    const terminal = stream.events.at(-1);
    assert.equal(terminal.type, 'done');
    const calls = terminal.message.content.filter(block => block.type === 'toolCall');
    assert.equal(calls.length, 1);
    if (missing) {
      assert.equal(calls[0].name, 'antigravity');
      const recorded = replay.take(calls[0].id);
      assert.match(recorded.output, /summary only; full native result unavailable/);
      assert.match(recorded.output, /Fixture native record unavailable/);
    } else {
      assert.equal(calls[0].name, 'antigravity');
      let wrapper;
      registerWrapperTool({ registerTool: tool => { wrapper = tool; } }, replay);
      const result = await wrapper.execute(calls[0].id, calls[0].arguments);
      assert.equal(result.content[0].text, originalOutput);
      assert.equal(result.details.output, originalOutput);
      const expanded = wrapper.renderResult(result, { expanded: true },
        { fg: (_color, text) => text }, { isError: false });
      assert.ok(expanded.text.includes(originalOutput));
    }
  });
}
