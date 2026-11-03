import assert from 'node:assert/strict';
import test from 'node:test';
import { createAntigravityRuntime } from '../src/runtime/runtime.ts';
import { AgyDriverSession } from '../src/driver/agy-driver.ts';

import { fixture, flush } from './offline-fixture.mjs';
import { AGY_CONVERSATION_STATE_ENTRY, restorableAgyConversation } from '../src/native/conversation-state.ts';
import { AGY_COMPACTION_ENTRY } from '../src/native/agy-compaction.ts';
import { ConversationSync } from '../src/extension/conversation-sync.ts';
import { registerSessionHooks } from '../src/extension/session-hooks.ts';

const ctx = { cwd: 'fixture-project', model: { provider: 'antigravity' },
  sessionManager: { getSessionId: () => 'pi-session' } };
const STALE = 'This extension ctx is stale after session replacement or reload.';
// Mirrors the SDK: session-bound getters and pi actions throw once replaced.
function staleableCtx(state) {
  const guard = () => { if (state.stale) throw new Error(STALE); };
  return {
    get cwd() { guard(); return 'fixture-project'; },
    get model() { guard(); return { provider: 'antigravity' }; },
    get sessionManager() { guard(); return { getSessionId: () => 'pi-session' }; },
  };
}

function runtime(f, pid, requests) {
  const child = f.child(pid);
  const driver = new AgyDriverSession(f.executionDependencies);
  const executor = { run: request => {
    requests.push(request);
    return driver.run({ ...request, binary: 'OFFLINE_FAKE', spawnOverride: () => child });
  }, snapshot: () => driver.snapshot(), close: (...args) => driver.close(...args) };
  const rt = createAntigravityRuntime(executor, undefined, f.childrenHost);
  return { rt, service: rt, child };
}

// Run the actual session hooks and ConversationSync against the actual runtime;
// only Pi, the bridge and the UI are stubbed.
function sessionHooks(r, branch, appendGuard = () => {}) {
  const handlers = {};
  // Tests swap holder.runtime mid-test. Methods stay bound to the real runtime
  // because it keeps its state in private fields.
  const holder = { runtime: r.rt };
  const current = new Proxy({}, { get(_target, key) {
    const value = holder.runtime[key];
    return typeof value === 'function' ? value.bind(holder.runtime) : value;
  } });
  const append = (customType, data) => { appendGuard(); branch.push({ type: 'custom', customType, data }); };
  const sync = new ConversationSync(current, append);
  const monitor = { cleared: 0, clear() { this.cleared++; } };
  registerSessionHooks({ pi: { on: (event, fn) => { (handlers[event] ??= []).push(fn); } },
    runtime: current, sync, monitor, bridge: {}, refreshStaleModels: async () => {} });
  return {
    holder, sync, monitor,
    compact: context => handlers.session_compact[0]({}, context),
    // The second agent_settled handler persists; the first settles bridge calls and widgets.
    persist: context => handlers.agent_settled[1]({}, context),
  };
}

const restoreOld = (r, systemPromptHash = 'same-system') => r.service.restoreConversation({
  conversationId: 'native-old', cwd: 'fixture-project', modelId: 'gemini-fixture', turns: 12,
  usage: { input_tokens: 460_000 }, systemPromptHash,
});
const result = child => child.send({ event: 'result', result: { status: 'SUCCESS', response: 'done' } });

test('session_compact discards the pre-compaction native conversation and bootstraps the compacted branch', async () => {
  const f = fixture();
  const requests = [];
  const r = runtime(f, 900101, requests);
  const branch = [];
  const h = sessionHooks(r, branch);
  try {
    await restoreOld(r);
    branch.push({ type: 'custom', customType: AGY_CONVERSATION_STATE_ENTRY, data: {
      version: 1, kind: 'conversation', sessionId: 'pi-session', conversationId: 'native-old',
      cwd: 'fixture-project', modelId: 'gemini-fixture', turns: 12, usage: { input_tokens: 460_000 },
      contextTokens: 460_000 } });
    branch.push({ type: 'compaction' });
    h.sync.contextTokens = 460_000;

    await h.compact(ctx);

    assert.equal(branch.at(-1).customType, AGY_CONVERSATION_STATE_ENTRY);
    assert.equal(branch.at(-1).data.kind, 'reset');
    // A reload after compaction must not resurrect the old conversation.
    assert.equal(restorableAgyConversation(branch, 'pi-session', 'fixture-project'), undefined);
    assert.equal(h.sync.contextTokens, undefined);
    assert.equal(h.monitor.cleared, 1);
    const snapshot = await r.service.snapshot();
    assert.equal(snapshot.conversationId, undefined);
    assert.equal(Object.keys(snapshot.conversationUsage).length, 0);

    const bootstrap = '## Restored pi conversation context\n<summary>compacted</summary>';
    const prompt = 'Continue the interrupted task.';
    const controller = await r.service.beginStreamTurn({
      prompt, modelId: 'gemini-fixture', systemPromptHash: 'same-system', historyBootstrap: bootstrap });
    await flush();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].conversationId, undefined);
    assert.equal(requests[0].prompt, `${bootstrap}\n\n${prompt}`);
    result(r.child);
    assert.equal((await controller.next()).status, 'OK');
  } finally {
    await r.service.close();
  }
});

test('a session replaced while persisting skips the write; other append failures still surface', async () => {
  const f = fixture();
  const r = runtime(f, 900104, []);
  const branch = [];
  const state = { stale: false };
  let failure;
  const h = sessionHooks(r, branch, () => {
    if (state.stale) throw new Error(STALE);
    if (failure) throw failure;
  });
  try {
    await restoreOld(r);
    const realRuntime = r.rt;
    // Pi replaces the session while the snapshot is read.
    h.holder.runtime = new Proxy(realRuntime, { get(target, key) {
      if (key === 'snapshot') state.stale = true;
      const value = target[key];
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    await h.persist(staleableCtx(state));
    assert.equal(branch.length, 0);
    assert.equal(h.sync.persistedKey, undefined);

    h.holder.runtime = realRuntime;
    state.stale = false;
    failure = new Error('disk full');
    await assert.rejects(h.persist(staleableCtx(state)), /disk full/);
  } finally {
    await r.service.close();
  }
});

test('a session replaced during session_compact still resets the runtime', async () => {
  const f = fixture();
  const r = runtime(f, 900105, []);
  const branch = [];
  const state = { stale: false };
  const h = sessionHooks(r, branch, () => { if (state.stale) throw new Error(STALE); });
  try {
    await restoreOld(r);
    h.holder.runtime = new Proxy(r.rt, { get(target, key) {
      if (key === 'setSession') state.stale = true;
      const value = target[key];
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    await h.compact(staleableCtx(state));
    assert.equal(branch.length, 0);
    const snapshot = await r.service.snapshot();
    assert.equal(snapshot.conversationId, undefined);
  } finally {
    await r.service.close();
  }
});

test('changed instructions report the discarded conversation before usage, so no AGY compaction is recorded', async () => {
  const f = fixture();
  const requests = [];
  const r = runtime(f, 900102, requests);
  const branch = [];
  const h = sessionHooks(r, branch);
  try {
    await restoreOld(r, 'old-system');
    h.sync.contextTokens = 460_000; // session_start restores the persisted context size
    const controller = await r.service.beginStreamTurn({
      prompt: 'next', modelId: 'gemini-fixture', systemPromptHash: 'new-system', historyBootstrap: 'BOOT' });
    await flush();
    assert.equal(requests[0].conversationId, undefined);
    assert.equal(requests[0].prompt, 'BOOT\n\nnext');
    r.child.send({ event: 'step_update', step_update: { step_index: 1, step_type: 'agent_response',
      state: 'DONE', usage: { input_tokens: 80_000 } } });
    result(r.child);
    const seen = [];
    for (;;) {
      const activity = await controller.next();
      if (!activity) break;
      seen.push(activity.type);
      h.sync.observe(activity);
      if (activity.type === 'result') break;
    }
    assert.equal(seen[0], 'conversation_fallback');
    assert.ok(seen.includes('usage'));
    assert.equal(branch.filter(entry => entry.customType === AGY_COMPACTION_ENTRY).length, 0);
    assert.equal(h.sync.contextTokens, 80_000);
  } finally {
    await r.service.close();
  }
});

test('unchanged instructions resume without a fallback, and a same-conversation drop is still recorded', async () => {
  const f = fixture();
  const requests = [];
  const r = runtime(f, 900103, requests);
  const branch = [];
  const h = sessionHooks(r, branch);
  try {
    await restoreOld(r);
    const controller = await r.service.beginStreamTurn({
      prompt: 'next', modelId: 'gemini-fixture', systemPromptHash: 'same-system' });
    await flush();
    assert.equal(requests[0].conversationId, 'native-old');
    result(r.child);
    assert.equal((await controller.next()).type, 'result');

    h.sync.observe({ type: 'usage', usage: { input_tokens: 300_000 } });
    h.sync.observe({ type: 'usage', usage: { input_tokens: 80_000 } });
    const markers = branch.filter(entry => entry.customType === AGY_COMPACTION_ENTRY);
    assert.equal(markers.length, 1);
    assert.equal(markers[0].data.beforeTokens, 300_000);
    assert.equal(markers[0].data.afterTokens, 80_000);
  } finally {
    await r.service.close();
  }
});
