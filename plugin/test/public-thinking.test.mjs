import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { BinaryWriter, WireType } from '@bufbuild/protobuf/wire';
import { AssistantMessageWriter } from '../src/provider/message-writer.ts';
import { streamAntigravity } from '../src/provider/stream.ts';
import { AgyReplayStore } from '../src/provider/replay.ts';
import { AgyTurnController } from '../src/runtime/turn.ts';
import { createAntigravityRuntime } from '../src/runtime/runtime.ts';
import { AgyDriverSession, AgyOneShotExecutor } from '../src/driver/agy-driver.ts';
import { fixture, flush, memoryStream } from './offline-fixture.mjs';

const ID = '11111111-1111-4111-8111-111111111111';
const key = step => `${ID}:${step}`;
const thoughts = message => message.content.filter(p => p.type === 'thinking').map(p => p.thinking);

function writerFixture() {
  const f = fixture();
  const stream = memoryStream();
  const output = { content: [] };
  return { f, stream, output, writer: new AssistantMessageWriter(output, stream) };
}

function providerOptions() {
  return {
    latestUserPrompt: () => ({ prompt: 'fixture' }), piHistoryBootstrap: () => undefined,
    normalizeContext: context => context, getCurrentSystemPrompt: () => '',
    readAgyProcessProfile: () => ({}), resolveAgyModelEffort: () => undefined,
    resolveBridgeResultsFromContext: () => 0, calculateCost: () => {},
    createAssistantMessageEventStream: memoryStream,
  };
}
const model = { id: 'fixture', api: 'fixture', provider: 'antigravity' };
const snapshot = (stepId, text, status = 8) => ({ conversationId: ID, stepId, text, status });

function database(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-public-thinking-'));
  const previous = process.env.JETSKI_APP_DATA_DIR;
  process.env.JETSKI_APP_DATA_DIR = root;
  fs.mkdirSync(path.join(root, 'conversations'));
  const db = new DatabaseSync(path.join(root, 'conversations', `${ID}.db`));
  db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_payload BLOB)');
  const put = (idx, text, status = 8, target = db) => {
    const planner = new BinaryWriter().tag(3, WireType.LengthDelimited).string(text).finish();
    const payload = new BinaryWriter().tag(20, WireType.LengthDelimited).bytes(planner).finish();
    target.prepare('INSERT OR REPLACE INTO steps VALUES (?,15,?,?)').run(idx, status, payload);
  };
  t.after(() => {
    db.close();
    if (previous === undefined) delete process.env.JETSKI_APP_DATA_DIR;
    else process.env.JETSKI_APP_DATA_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, put, lock: () => db.exec('BEGIN EXCLUSIVE'), unlock: () => db.exec('ROLLBACK') };
}

test('received batches become small real-text deltas; Unicode graphemes and final content stay exact', async () => {
  const { f, stream, output, writer } = writerFixture();
  const text = '甲乙🙂👨‍👩‍👧‍👦e\u0301。' + '检查接缝并验证公开摘要。'.repeat(12);
  writer.updateNativeThinking(key(1), text);
  assert.notEqual(thoughts(output)[0], text);
  assert.ok(text.startsWith(thoughts(output)[0]));
  const first = thoughts(output)[0];
  await f.tick(120);
  assert.ok(thoughts(output)[0].length > first.length);
  assert.ok(thoughts(output)[0].length < text.length);
  const allowed = new Set(['']);
  let prefix = '';
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) {
    prefix += segment; allowed.add(prefix);
  }
  let received = '';
  for (const event of stream.events.filter(e => e.type === 'thinking_delta')) {
    received += event.delta; assert.ok(allowed.has(received));
  }
  writer.endNativeThinking(key(1), text);
  writer.done('stop'); writer.end();
  assert.equal(stream.events.filter(e => e.type === 'thinking_delta').map(e => e.delta).join(''), text);
  assert.deepEqual(thoughts(output), [text]);
  assert.equal(stream.events.filter(e => e.type === 'thinking_start').length, 1);
  assert.equal(stream.events.filter(e => e.type === 'thinking_end').length, 1);
  assert.equal(f.timers.size, 0);
});

test('a tool boundary flushes the animation immediately; completed steps never reopen', () => {
  const { f, output, stream, writer } = writerFixture();
  const text = '真实公开摘要'.repeat(40);
  writer.updateNativeThinking(key(1), text);
  const call = { type: 'toolCall', id: 'once', name: 'probe', arguments: {} };
  writer.closeToolCall(writer.openToolCall(call), call);
  assert.deepEqual(thoughts(output), [text]);
  assert.equal(f.timers.size, 0);
  writer.updateNativeThinking(key(1), text + 'late duplicate');
  writer.updateNativeThinking(key(3), '工具后的下一段');
  writer.endNativeThinking(key(3), '工具后的下一段');
  writer.done('toolUse'); writer.end();
  assert.deepEqual(output.content.map(p => p.type), ['thinking', 'toolCall', 'thinking']);
  assert.equal(stream.events.filter(e => e.type === 'thinking_start').length, 2);
  assert.deepEqual(thoughts(output), [text, '工具后的下一段']);
});

test('answer-first reserves one actual thinking slot; a late snapshot cannot move its index', () => {
  const { output, stream, writer, f } = writerFixture();
  writer.appendTextDelta('正文先到', key(1));
  writer.updateNativeThinking(key(1), '后读到的摘要🙂');
  writer.endNativeThinking(key(1), '后读到的摘要🙂');
  writer.done('stop'); writer.end();
  assert.deepEqual(output.content.map(p => p.type), ['thinking', 'text']);
  assert.equal(stream.events.filter(e => e.type === 'thinking_start').length, 1);
  assert.equal(stream.events.find(e => e.type === 'thinking_start').contentIndex, 0);
  assert.equal(output.content[1].text, '正文先到');
  assert.deepEqual(thoughts(output), ['后读到的摘要🙂']);
  assert.equal(f.timers.size, 0);
});

for (const reason of ['aborted', 'error']) test(`${reason} flushes every already-received character, including authoritative revisions`, () => {
  const { output, stream, writer, f } = writerFixture();
  writer.updateNativeThinking(key(1), '原始公开摘要'.repeat(20));
  writer.updateNativeThinking(key(1), '修订后的公开摘要🙂');
  writer.error(reason); writer.end();
  assert.equal(stream.events.at(-1).type, 'error');
  assert.equal(stream.events.at(-1).reason, reason);
  assert.deepEqual(thoughts(output), ['修订后的公开摘要🙂']);
  assert.equal(stream.events.some(e => e.type === 'done'), false);
  assert.equal(f.timers.size, 0);
});

test('controller deduplicates native progress and seals steps across polling and Pi re-entry', async () => {
  const c = new AgyTurnController('fixture'); c.bindNativeConversation(ID);
  let progress = 0; c.subscribeNativeProgress(() => progress++);
  assert.equal(c.acceptNativeThinking(snapshot(1, '')), false);
  c.acceptNativeThinking(snapshot(1, '真实'));
  c.acceptNativeThinking(snapshot(1, '真实'));
  c.acceptNativeThinking(snapshot(1, '真实摘要', 3));
  assert.equal(c.acceptNativeThinking(snapshot(1, 'late')), true);
  assert.equal(progress, 2);
  assert.equal(c.claimThought(), false);
  c.close();
  const events = [];
  for (let e; (e = await c.next()) !== null;) events.push(e);
  assert.deepEqual(events.map(e => e.type), ['native_thinking_snapshot', 'native_thinking_snapshot', 'native_thinking_end']);
  assert.equal(events.at(-1).text, '真实摘要');
});

test('cancel display drain preserves non-thinking queue entries and the next tool boundary', async () => {
  const c = new AgyTurnController('fixture'); c.bindNativeConversation(ID);
  c.acceptNativeThinking(snapshot(1, 'current'));
  c.push({ type: 'usage', usage: { output_tokens: 10 } });
  c.push({ type: 'bridge_call', id: 'next', name: 'probe', args: {} });
  c.push({ type: 'native_thinking_snapshot', ...snapshot(3, 'next-message') });
  assert.deepEqual(c.takePendingThinking().map(e => e.text), ['current']);
  c.close();
  assert.equal((await c.next()).type, 'usage');
  assert.equal((await c.next()).type, 'bridge_call');
  assert.equal((await c.next()).text, 'next-message');
});

test('runtime reads before a real bridge boundary and keeps later thinking on the next Pi message', async t => {
  const db = database(t);
  const f = fixture(providerOptions());
  const requests = [];
  let finish;
  const runtime = createAntigravityRuntime(request => {
    requests.push(request); request.onConversation(ID);
    return new Promise(resolve => { finish = () => {
      const outcome = { status: 'OK', conversationId: ID, response: 'FINAL' };
      request.onActivity({ type: 'result', ...outcome }); resolve(outcome);
    }; });
  }, undefined, f.childrenHost);
  const provider = streamAntigravity({ ...f.providerOptions, runtime, replay: new AgyReplayStore(),
    bridge: { refreshTools() {}, serverName: 'fixture' } });
  const start = () => provider(model, { messages: [] }, {});
  try {
    const first = start(); await flush();
    db.put(1, '工具前的真实摘要'.repeat(20)); await f.tick(200);
    assert.ok(first.events.some(e => e.type === 'thinking_delta'));
    db.put(1, '工具前的完整摘要', 3);
    runtime.pushBridgeCall({ id: 'bridge-once', tool: 'probe', args: {} });
    await first.ended;
    const firstMessage = first.events.at(-1).message;
    assert.equal(firstMessage.stopReason, 'toolUse');
    assert.deepEqual(thoughts(firstMessage), ['工具前的完整摘要']);
    assert.equal(firstMessage.content.filter(p => p.type === 'toolCall').length, 1);
    runtime.finishBridgeCall('bridge-once');
    const second = start(); await flush();
    db.put(3, '工具后的思路'); await f.tick(240);
    db.put(3, '工具后的完整思路', 3);
    requests[0].onActivity({ type: 'text', stepId: 3, delta: 'FINAL' });
    requests[0].onActivity({ type: 'response_end', stepId: 3 });
    finish(); await second.ended;
    assert.equal(requests.length, 1);
    assert.deepEqual(thoughts(second.events.at(-1).message), ['工具后的完整思路']);
    await flush();
    assert.equal(f.timers.size, 0);
    const third = start(); await flush();
    assert.equal(requests.length, 2);
    db.put(5, '新用户轮，不带旧思路', 3);
    requests[1].onActivity({ type: 'text', stepId: 5, delta: 'FINAL' });
    finish(); await third.ended;
    assert.deepEqual(thoughts(third.events.at(-1).message), ['新用户轮，不带旧思路']);
  } finally { await runtime.close(); }
});

test('two live runtime observers interleave without sharing text, indices or shutdown ownership', async t => {
  const db = database(t);
  const otherId = '22222222-2222-4222-8222-222222222222';
  const file = path.join(db.root, 'conversations', `${otherId}.db`);
  fs.copyFileSync(path.join(db.root, 'conversations', `${ID}.db`), file);
  const otherDb = new DatabaseSync(file);
  const f = fixture(providerOptions());
  const requests = [];
  const make = (id, index) => {
    const runtime = createAntigravityRuntime(req => {
      req.onConversation(id);
      return new Promise(resolve => { requests[index] = () => {
        const result = { status: 'OK', conversationId: id, response: '' };
        req.onActivity({ type: 'result', ...result }); resolve(result);
      }; });
    }, undefined, f.childrenHost);
    return { runtime, provider: streamAntigravity({ ...f.providerOptions, runtime, replay: new AgyReplayStore(),
      bridge: { refreshTools() {}, serverName: 'fixture' } }) };
  };
  const a = make(ID, 0), b = make(otherId, 1);
  try {
    const first = a.provider(model, { messages: [] }), second = b.provider(model, { messages: [] });
    await flush();
    db.put(1, '会话A的思路'.repeat(20)); db.put(1, '会话B的思路'.repeat(20), 8, otherDb);
    await f.tick(200);
    requests[0](); await first.ended;
    assert.deepEqual(thoughts(first.events.at(-1).message), ['会话A的思路'.repeat(20)]);
    db.put(1, '只有会话B的末版🙂', 3, otherDb); await f.tick(200);
    requests[1](); await second.ended; await flush();
    assert.deepEqual(thoughts(second.events.at(-1).message), ['只有会话B的末版🙂']);
    assert.equal(f.timers.size, 0);
  } finally { await a.runtime.close(); await b.runtime.close(); otherDb.close(); }
});

for (const locked of [false, true]) test(locked ? 'a locked bridge boundary never replays an unseen old step in the next message'
  : 'a database ahead of stdout holds future thinking until its tool result is queued', async t => {
  const db = database(t);
  const f = fixture(providerOptions());
  let request, finish;
  const runtime = createAntigravityRuntime(req => {
    request = req; req.onConversation(ID);
    return new Promise(resolve => { finish = () => {
      const result = { status: 'OK', conversationId: ID, response: 'FINAL' };
      req.onActivity({ type: 'result', ...result }); resolve(result);
    }; });
  }, undefined, f.childrenHost);
  const provider = streamAntigravity({ ...f.providerOptions, runtime, replay: new AgyReplayStore(),
    bridge: { refreshTools() {}, serverName: 'fixture' } });
  try {
    const first = provider(model, { messages: [] }); await flush();
    db.put(1, 'BEFORE_TOOL', 3);
    if (locked) {
      db.lock();
      try { runtime.pushBridgeCall({ id: 'bridge', tool: 'probe', args: {},
        nativeServerName: 'fixture', nativeToolName: 'probe' }); }
      finally { db.unlock(); }
      await first.ended; runtime.finishBridgeCall('bridge');
    } else db.put(3, 'AFTER_TOOL_PARTIAL');
    request.onActivity({ type: 'response_end', stepId: 1 });
    const tool = locked ? { name: 'call_mcp_tool', args: { ServerName: 'fixture', ToolName: 'probe' } }
      : { name: 'run_command', args: {} };
    request.onActivity({ type: 'tool_start', stepId: 2, ...tool });
    request.onActivity({ type: 'tool_done', stepId: 2, ...tool, output: 'RECORDED' });
    db.put(3, 'AFTER_TOOL_FINAL', 3);
    request.onActivity({ type: 'text', stepId: 3, delta: 'FINAL' });
    finish(); await first.ended;
    const second = provider(model, { messages: [] }); await second.ended;
    assert.deepEqual(thoughts(first.events.at(-1).message), locked ? [] : ['BEFORE_TOOL']);
    assert.deepEqual(thoughts(second.events.at(-1).message), ['AFTER_TOOL_FINAL']);
    assert.equal(first.events.at(-1).message.stopReason, 'toolUse');
    assert.equal(second.events.at(-1).message.stopReason, 'stop');
  } finally { await runtime.close(); }
});

test('executor failure preserves public partial and releases the observer without emitting success', async t => {
  const db = database(t);
  const f = fixture(providerOptions());
  let fail;
  const runtime = createAntigravityRuntime(request => {
    request.onConversation(ID);
    return new Promise((_resolve, reject) => { fail = reject; });
  }, undefined, f.childrenHost);
  const provider = streamAntigravity({ ...f.providerOptions, runtime, replay: new AgyReplayStore(),
    bridge: { refreshTools() {}, serverName: 'fixture' } });
  try {
    const stream = provider(model, { messages: [] }); await flush();
    db.put(1, '失败前已经收到的真实摘要'.repeat(20)); await f.tick(200);
    fail(new Error('native executor failed')); await stream.ended; await flush();
    assert.equal(stream.events.at(-1).type, 'error');
    assert.match(stream.events.at(-1).error.errorMessage, /native executor failed/);
    assert.deepEqual(thoughts(stream.events.at(-1).error), ['失败前已经收到的真实摘要'.repeat(20)]);
    assert.equal(stream.events.some(e => e.type === 'done'), false);
    assert.equal(f.timers.size, 0);
  } finally { await runtime.close(); }
});

test('cancel drains observed thinking before the queued tool without displaying or executing later steps', async () => {
  const f = fixture(providerOptions());
  const c = new AgyTurnController('fixture'); c.bindNativeConversation(ID);
  const abort = new AbortController();
  const provider = streamAntigravity({ ...f.providerOptions,
    runtime: { beginStreamTurn: () => c, finishTurn() {}, steerActiveTurn() {}, snapshot: () => ({}) },
    replay: {}, bridge: { refreshTools() {}, serverName: 'fixture' } });
  const stream = provider(model, { messages: [] }, { signal: abort.signal });
  await flush();
  c.acceptNativeThinking(snapshot(1, '取消前已收到的完整摘要'.repeat(10)));
  c.sealNativeThinking(1);
  c.push({ type: 'bridge_call', id: 'must-not-run', name: 'probe', args: {} });
  c.push({ type: 'native_thinking_snapshot', ...snapshot(3, '不属于当前消息的下一步') });
  abort.abort();
  await stream.ended;
  const result = stream.events.at(-1);
  assert.equal(result.type, 'error');
  assert.equal(result.reason, 'aborted');
  assert.deepEqual(thoughts(result.error), ['取消前已收到的完整摘要'.repeat(10)]);
  assert.equal(result.error.content.some(p => p.type === 'toolCall'), false);
  assert.equal(f.timers.size, 0);
  c.close();
});

for (const oneShot of [false, true]) test(`${oneShot ? 'one-shot' : 'persistent'} standalone calls retain their explicit wall cap while native progress resets silence`, async () => {
  const f = fixture();
  const child = f.child(987654);
  f.childrenHost.spawnSync = (_cmd, args) => {
    f.kills.push(Number(args.at(-1)));
    queueMicrotask(() => { child.exitCode = 1; child.emit('close', 1, null); });
  };
  let progress, unsubscribed = 0;
  const driver = oneShot ? new AgyOneShotExecutor(f.executionDependencies) : new AgyDriverSession(f.executionDependencies);
  const run = driver.run({ prompt: 'fixture', binary: 'OFFLINE_FAKE', spawnOverride: () => child,
    timeoutMs: 150000, inactivityTimeoutMs: 120000,
    subscribeNativeProgress(listener) { progress = listener; return () => { unsubscribed++; }; } });
  const rejected = assert.rejects(run, /timed out after 150s/);
  try {
    await flush();
    await f.tick(100000); progress();
    await f.tick(21000);
    assert.deepEqual(f.kills, []); // Native public text extended the I/O deadline beyond 120s.
    await f.tick(29000); await rejected;
    assert.equal(unsubscribed, 1);
    assert.equal(f.kills.length, 1); // The 150s model cap was not renewed by display progress.
  } finally { await driver.close('shutdown'); }
});
