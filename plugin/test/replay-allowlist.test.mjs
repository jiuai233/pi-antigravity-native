
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AgyTurnController } from '../src/runtime/turn.ts';
import { streamAntigravity } from '../src/provider/stream.ts';
import { fixture, memoryStream } from './offline-fixture.mjs';
import { AgyReplayStore } from '../src/provider/replay.ts';
import { agyIncompleteToolError } from '../src/input/prompt.ts';

function replayFixture(activeTools, { missing = false } = {}) {
  const cwd = path.join(os.tmpdir(), 'agy-allowlist-fixture');
  const output = 'Native result\n' + 'recorded line\n'.repeat(1500) + 'REPLAY_TAIL';
  const f = fixture({
    latestUserPrompt: () => ({ prompt: 'fixture' }), piHistoryBootstrap: () => undefined,
    normalizeContext: context => context, getCurrentSystemPrompt: () => '',
    readAgyProcessProfile: () => ({}), resolveAgyModelEffort: () => undefined,
    resolveBridgeResultsFromContext: () => 0, calculateCost: () => {},
    createAssistantMessageEventStream: memoryStream,
    WRAPPER_TOOL_NAME: 'antigravity', agyIncompleteToolError,
    createAntigravityRuntime: () => { throw new Error('Unexpected isolated runtime'); },
    readNativeToolResult: () => {
      if (missing) throw new Error('Fixture record unavailable');
      return { args: currentArgs, output };
    },
  });
  const controller = new AgyTurnController('fixture');
  const replay = new AgyReplayStore();
  let currentArgs;
  return {
    output, replay, controller,
    push(type, name, args, extra = {}) {
      currentArgs = args;
      controller.push({ type, stepId: 7, name, args, output, ...extra });
    },
    async run() {
      const stream = streamAntigravity({ ...f.providerOptions,
        runtime: { beginStreamTurn: () => controller, finishTurn() {}, steerActiveTurn() {}, snapshot: () => ({ cwd, conversationId: 'fixture' }) },
        replay, bridge: { refreshTools() {}, serverName: 'fixture' },
        isActiveTool: name => activeTools.includes(name),
      })({ id: 'fixture', api: 'fixture', provider: 'antigravity' }, { messages: [] }, {});
      await stream.ended;
      return stream;
    },
  };
}

for (const mode of ['active-done', 'done-only', 'late-path', 'missing-record', 'error', 'incomplete']) {
  test(`restricted tool surface keeps view_file ${mode} as text replay, not a missing tool call`, async () => {
    const fx = replayFixture(['read'], { missing: mode === 'missing-record' });
    const args = { AbsolutePath: 'fixture.mp4' };
    if (mode !== 'done-only') fx.push('tool_start', 'view_file', mode === 'late-path' ? {} : args);
    if (mode !== 'incomplete') fx.push(mode === 'error' ? 'tool_error' : 'tool_done', 'view_file', args,
      { message: 'Native inspection failed', output: 'CLI summary' });
    fx.controller.push({ type: 'result', status: 'OK', response: 'Final native response' });
    fx.controller.close();
    const stream = await fx.run();
    const terminal = stream.events.at(-1);
    assert.equal(terminal.type, 'done');
    assert.equal(terminal.message.stopReason, 'stop');
    assert.equal(terminal.message.content.some(block => block.type === 'toolCall'), false);
    assert.equal(stream.events.some(event => event.type.startsWith('toolcall_')), false);
    const text = terminal.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
    assert.match(text, /AGY replay only: view_file; no Pi tool executed/);
    assert.ok(text.includes('Final native response'));
    if (mode === 'error') assert.ok(text.includes('Native tool failed: Native inspection failed'));
    else if (mode === 'incomplete') assert.ok(text.includes('Native tool failed: agy tool call did not complete'));
    else if (mode === 'missing-record') {
      assert.ok(text.includes('summary only; full native result unavailable'));
      assert.ok(text.includes('CLI summary'));
    } else assert.ok(text.includes(fx.output), 'full native view_file body, including the tail, is preserved');
    assert.doesNotMatch(text, /Tool antigravity not found/);
    // Delta-only consumers must reconstruct the same text with balanced indices.
    for (const [index, block] of terminal.message.content.entries()) {
      if (block.type !== 'text') continue;
      assert.equal(stream.events.filter(event => event.type === 'text_start' && event.contentIndex === index).length, 1);
      assert.equal(stream.events.filter(event => event.type === 'text_end' && event.contentIndex === index).length, 1);
      assert.equal(stream.events.filter(event => event.type === 'text_delta' && event.contentIndex === index)
        .map(event => event.delta).join(''), block.text);
    }
    assert.equal(fx.replay.size, 0);
  });
}

test('restricted replay text does not turn a native terminal error into success', async () => {
  const fx = replayFixture(['read']);
  fx.push('tool_done', 'read_file', { path: 'fixture.txt' }, { output: 'Recorded output before failure' });
  fx.controller.push({ type: 'result', status: 'ERROR', response: '', error: 'Native turn interrupted' });
  const stream = await fx.run();
  const terminal = stream.events.at(-1);
  assert.equal(terminal.type, 'error');
  assert.equal(terminal.error.stopReason, 'error');
  assert.equal(terminal.error.errorMessage, 'Native turn interrupted');
  assert.ok(terminal.error.content[0].text.includes('Recorded output before failure'));
  assert.equal(fx.replay.size, 0);
});

test('active wrapper still receives incomplete-step errors as tool replay', async () => {
  const fx = replayFixture(['antigravity']);
  fx.push('tool_start', 'view_file', { AbsolutePath: 'fixture.wav' });
  fx.controller.push({ type: 'result', status: 'OK', response: '' });
  const stream = await fx.run();
  const message = stream.events.at(-1).message;
  assert.equal(message.stopReason, 'toolUse');
  const call = message.content.find(block => block.type === 'toolCall');
  assert.equal(call.name, 'antigravity');
  assert.match(fx.replay.take(call.id).error, /agy tool call did not complete/);
  assert.equal(fx.replay.size, 0);
});

test('unmapped read_file remains replay-only without requiring or executing a Pi tool', async () => {
  const fx = replayFixture([]);
  fx.push('tool_start', 'read_file', { path: 'fixture.txt' });
  fx.push('tool_done', 'read_file', { path: 'fixture.txt' }, { output: 'Recorded read_file output' });
  fx.controller.push({ type: 'result', status: 'OK', response: '' });
  const stream = await fx.run();
  assert.equal(stream.events.at(-1).message.stopReason, 'stop');
  const content = stream.events.at(-1).message.content;
  assert.equal(content.length, 1);
  assert.match(content[0].text, /AGY replay only: read_file/);
  assert.ok(content[0].text.includes('Recorded read_file output'));
  assert.equal(fx.replay.size, 0);
});

for (const [name, args, builtin] of [
  ['view_file', { AbsolutePath: 'fixture.txt' }, 'read'],
  ['grep_search', { Query: 'fixture' }, 'grep'],
  ['find_by_name', { Pattern: '*.txt' }, 'find'],
  ['list_dir', { DirectoryPath: '.' }, 'ls'],
]) {
  for (const enabled of [true, false]) {
    test(`${builtin} native completion never executes a second Pi operation (${enabled})`, async () => {
      const active = enabled ? [builtin] : [];
      const fx = replayFixture(active);
      fx.push('tool_start', name, args);
      fx.push('tool_done', name, args);
      fx.controller.push({ type: 'result', status: 'OK', response: '' });
      const stream = await fx.run();
      const message = stream.events.at(-1).message;
      const calls = message.content.filter(block => block.type === 'toolCall');
      assert.deepEqual(Array.from(calls, call => call.name), []);
      assert.equal(message.stopReason, 'stop');
      assert.deepEqual(active, enabled ? [builtin] : []);
      assert.equal(fx.replay.size, 0);
    });
  }
}

test('text replay continues to a real bridge handoff without inventing a replay tool call', async () => {
  const fx = replayFixture(['read']);
  const args = { AbsolutePath: 'fixture.wav' };
  fx.push('tool_start', 'view_file', args);
  fx.push('tool_done', 'view_file', args);
  fx.controller.push({ type: 'bridge_call', id: 'bridge-read', name: 'read', args: { path: 'fixture.txt' } });
  const stream = await fx.run();
  const message = stream.events.at(-1).message;
  assert.equal(message.stopReason, 'toolUse');
  assert.deepEqual(Array.from(message.content.filter(block => block.type === 'toolCall'), call => call.name), ['read']);
  assert.ok(message.content[0].text.includes(fx.output));
  assert.equal(fx.replay.size, 0);
});
