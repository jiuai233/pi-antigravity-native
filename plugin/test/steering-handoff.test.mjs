
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createAntigravityRuntime } from '../src/runtime/runtime.ts';
import { streamAntigravity } from '../src/provider/stream.ts';
import { AgyReplayStore } from '../src/provider/replay.ts';
import { AgyPiBridge, resolveBridgeResultsFromContext } from '../src/extension/bridge.ts';
import { latestUserPrompt } from '../src/input/pi-input.ts';
import { fixture, flush, memoryStream } from './offline-fixture.mjs';

const toolResult = (id, text, isError = false) => ({ role: 'toolResult', toolCallId: id,
  isError, content: [{ type: 'text', text }] });
const providerDeps = {
  latestUserPrompt, piHistoryBootstrap: () => undefined,
  normalizeContext: context => context, getCurrentSystemPrompt: () => '',
  readAgyProcessProfile: () => ({}), resolveAgyModelEffort: () => undefined,
  calculateCost: () => {}, createAssistantMessageEventStream: memoryStream,
};
const textOf = message => message.content.filter(part => part.type === 'text').map(part => part.text).join('');

test('a pending steer rides in front of the newest resolved result exactly once', () => {
  const pending = new Set(['older', 'current']);
  const resolved = new Map();
  const bridge = {
    isAwaiting: id => pending.has(id) || id === 'lost-race',
    resolveCall: (id, result) => {
      if (!pending.delete(id)) return false;
      resolved.set(id, result);
      return true;
    },
  };
  let delivered = 0;
  const count = resolveBridgeResultsFromContext(bridge, [
    toolResult('history', 'old success'), toolResult('older', 'first result'),
    toolResult('current', 'actual success'), toolResult('lost-race', 'must not count'),
  ], { text: 'STEER', delivered: () => { delivered++; } });
  assert.equal(count, 2);
  assert.equal(delivered, 1);
  assert.deepEqual(resolved.get('current').content,
    [{ type: 'text', text: 'STEER' }, { type: 'text', text: 'actual success' }]);
  assert.deepEqual(resolved.get('older').content, [{ type: 'text', text: 'first result' }]);
  assert.equal(resolveBridgeResultsFromContext(bridge, [toolResult('current', 'actual success')]), 0);
});

test('a steer at a Pi tool gap rides in front of that tool result and agy keeps running', async () => {
  const f = fixture(providerDeps);
  let handler;
  const serverFactory = fn => {
    handler = fn;
    return { once() {}, off() {}, listen(_port, _host, ready) { ready(); },
      address: () => ({ port: 12345 }), close: done => done() };
  };
  const requests = [];
  const completions = [];
  const rt = createAntigravityRuntime(request => {
    requests.push(request);
    request.onConversation('native-fixture');
    return new Promise((resolve, reject) => {
      request.signal.addEventListener('abort', () => reject(new Error('native canceled')), { once: true });
      completions.push(() => {
        const outcome = { status: 'OK', response: 'done', conversationId: 'native-fixture' };
        request.onActivity({ type: 'result', ...outcome });
        resolve(outcome);
      });
    });
  }, undefined, f.childrenHost);
  const bridge = new AgyPiBridge(undefined, serverFactory);
  bridge.setToolSource(() => ['write', 'read'].map(name => ({ name, parameters: {} })));
  bridge.setOnCall(call => rt.pushBridgeCall(call));
  bridge.setOnSettled(id => rt.finishBridgeCall(id));
  const provider = streamAntigravity({ ...f.providerOptions, runtime: rt, replay: {}, bridge });
  const messages = [{ role: 'user', content: 'Write review.json and report.md.' }];
  const start = () => provider({ id: 'fixture', api: 'fixture', provider: 'antigravity' },
    { messages: [...messages] }, {});
  async function call(tool, args) {
    const req = new EventEmitter();
    req.headers = {}; req.method = 'POST';
    const response = new Promise(resolve => {
      handler(req, { writeHead() {}, end: body => resolve(JSON.parse(body)) });
    });
    req.emit('data', Buffer.from(JSON.stringify({ id: 1, method: 'tools/call',
      params: { name: `pi__${tool}`, arguments: args } })));
    req.emit('end');
    await flush();
    return { response };
  }
  try {
    await bridge.start();
    const first = start(); await flush();
    const write = await call('write', { path: 'review.json', content: '{"review":"done"}' });
    await first.ended;
    messages.push(first.events.at(-1).message);
    const writeId = messages.at(-1).content.find(part => part.type === 'toolCall').id;
    // Pi ran the write; the user's steer arrived before the next model call.
    messages.push(toolResult(writeId, 'Successfully wrote review.json (17 bytes).'));
    messages.push({ role: 'user', content: 'Skip report.md and reply now.' });
    const steered = start(); await flush();
    const writeResult = (await write.response).result;
    assert.equal(writeResult.isError, false);
    assert.match(writeResult.content[0].text, /New message from the user/);
    assert.match(writeResult.content[0].text, /Skip report\.md and reply now\./);
    assert.deepEqual(writeResult.content[1], { type: 'text', text: 'Successfully wrote review.json (17 bytes).' });
    assert.equal(requests.length, 1); // same agy process, no restart
    assert.equal(requests[0].signal.aborted, false);

    const read = await call('read', { path: 'review.json' });
    await steered.ended;
    messages.push(steered.events.at(-1).message);
    const readId = messages.at(-1).content.find(part => part.type === 'toolCall').id;
    messages.push(toolResult(readId, '{"review":"done"}'));
    const reentry = start(); await flush();
    assert.deepEqual((await read.response).result.content, [{ type: 'text', text: '{"review":"done"}' }]);
    assert.equal(requests.length, 1);
    completions[0]();
    await reentry.ended;
    assert.equal(reentry.events.at(-1).message.stopReason, 'stop');
  } finally {
    await bridge.close();
    await rt.close();
  }
});

test('a steer no tool result could carry continues the same native conversation after agy finishes', async () => {
  const f = fixture({ ...providerDeps,
    readNativeToolResult: (_conversation, step) => ({ args: { AbsolutePath: `file-${step}.txt` }, output: `SAVED_${step}` }) });
  const requests = [];
  let releaseFirst;
  let firstAbortedAtFinish;
  const rt = createAntigravityRuntime(async request => {
    requests.push(request);
    request.onConversation('native-chain');
    if (requests.length === 1) {
      request.onActivity({ type: 'tool_start', name: 'view_file', stepId: 1, args: { AbsolutePath: 'file-1.txt' } });
      request.onActivity({ type: 'tool_done', name: 'view_file', stepId: 1, args: { AbsolutePath: 'file-1.txt' }, output: 'summary' });
      request.onActivity({ type: 'usage', usage: { input_tokens: 1000, output_tokens: 10 } });
      await new Promise(resolve => { releaseFirst = resolve; });
      firstAbortedAtFinish = request.signal.aborted;
      const outcome = { status: 'OK', response: 'OLD ANSWER', conversationId: 'native-chain',
        usage: { input_tokens: 1000, output_tokens: 20 } };
      request.onActivity({ type: 'result', ...outcome });
      return outcome;
    }
    request.onActivity({ type: 'text', delta: 'STEERED ANSWER' });
    const outcome = { status: 'OK', response: 'STEERED ANSWER', conversationId: 'native-chain',
      usage: { input_tokens: 1100, output_tokens: 30 } };
    request.onActivity({ type: 'result', ...outcome });
    return outcome;
  }, undefined, f.childrenHost);
  const provider = streamAntigravity({ ...f.providerOptions, runtime: rt, replay: new AgyReplayStore(),
    bridge: { refreshTools() {}, serverName: 'fixture', isAwaiting: () => false } });
  const messages = [{ role: 'user', content: 'Read file-1.txt and summarize it.' }];
  const start = () => provider({ id: 'fixture', api: 'fixture', provider: 'antigravity' },
    { messages: [...messages] }, {});
  try {
    const first = start();
    await first.ended;
    const replayed = first.events.at(-1).message;
    assert.equal(replayed.stopReason, 'toolUse');
    messages.push(replayed);
    const wrapperId = replayed.content.find(part => part.type === 'toolCall').id;
    // A replay card boundary: no Pi bridge call is waiting for a result.
    messages.push(toolResult(wrapperId, 'replayed native read'));
    messages.push({ role: 'user', content: 'Change of plan: answer STEERED.' });
    const steered = start(); await flush();
    assert.equal(requests.length, 1);
    releaseFirst();
    await steered.ended;
    const final = steered.events.at(-1).message;
    assert.equal(final.stopReason, 'stop');
    assert.equal(firstAbortedAtFinish, false);
    assert.equal(requests.length, 2);
    assert.equal(requests[1].prompt, 'Change of plan: answer STEERED.');
    assert.equal(requests[1].conversationId, 'native-chain');
    assert.match(textOf(final), /OLD ANSWER[\s\S]*STEERED ANSWER/);
  } finally {
    await rt.close();
  }
});

test('a live turn re-attaches the same prompt and adopts a different one as a steer without a new request', async () => {
  const f = fixture();
  const requests = [];
  const rt = createAntigravityRuntime(request => {
    requests.push(request);
    return new Promise(() => {});
  }, undefined, f.childrenHost);
  try {
    const live = await rt.beginStreamTurn({ prompt: 'old', modelId: 'fixture' });
    await flush();
    assert.equal(await rt.beginStreamTurn({ prompt: 'old', modelId: 'fixture' }), live);
    const steered = await rt.beginStreamTurn({ prompt: 'new', modelId: 'fixture' });
    await flush();
    assert.equal(steered, live);
    assert.equal(live.prompt, 'new');
    assert.equal(live.pendingSteer(), 'new');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].signal.aborted, false);
    assert.equal(live.takeSteer(), 'new');
    assert.equal(live.pendingSteer(), undefined);
  } finally {
    await rt.close();
  }
});

for (const state of ['closed', 'detached']) {
  test(`a ${state} turn is replaced by a new prompt instead of steered`, async () => {
    const f = fixture();
    const requests = [];
    const rt = createAntigravityRuntime(request => {
      requests.push(request);
      return new Promise(() => {});
    }, undefined, f.childrenHost);
    try {
      const old = await rt.beginStreamTurn({ prompt: 'old', modelId: 'fixture' });
      await flush();
      if (state === 'closed') old.close();
      else rt.finishTurn(); // the provider stream ended without the result
      const controller = await rt.beginStreamTurn({ prompt: 'new', modelId: 'fixture' });
      await flush();
      assert.notEqual(controller, old);
      assert.equal(controller.pendingSteer(), undefined);
      assert.equal(requests.length, 2);
      assert.equal(requests[1].prompt, 'new');
      assert.equal(requests[0].signal.aborted, true);
    } finally {
      await rt.close();
    }
  });
}
