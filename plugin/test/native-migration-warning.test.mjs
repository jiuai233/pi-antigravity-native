import assert from 'node:assert/strict';
import test from 'node:test';
import { AgyDriverSession, AgyOneShotExecutor } from '../src/driver/agy-driver.ts';
import { AgyTurnController } from '../src/runtime/turn.ts';
import { streamAntigravity } from '../src/provider/stream.ts';

import { fixture, flush, memoryStream } from './offline-fixture.mjs';

for (const oneShot of [false, true]) {
  test(`${oneShot ? 'one-shot' : 'persistent'} surfaces migration failure without blocking the existing conversation`, async () => {
    let upgrades = 0;
    const message = '旧会话升级失败：database is locked；重载此会话重试。';
    const f = fixture({ upgradeNativeConversationDb: () => { upgrades++; return { status: 'failed', message }; } });
    const child = f.child(oneShot ? 900102 : 900101);
    f.executionDependencies.spawn = () => child; // Exercise the production migration branch, not spawnOverride.
    const executor = oneShot
      ? new AgyOneShotExecutor(f.executionDependencies)
      : new AgyDriverSession(f.executionDependencies);
    const activities = [];
    try {
      const pending = executor.run({ binary: 'OFFLINE_FAKE', conversationId: 'legacy',
        prompt: 'fixture', onActivity: activity => activities.push(activity) });
      await flush();
      assert.equal(upgrades, 1);
      assert.equal(activities[0].type, 'native_migration_warning');
      assert.equal(activities[0].message, message);
      child.send({ event: 'result', result: { status: 'SUCCESS', response: 'existing conversation still works' } });
      assert.equal((await pending).status, 'OK');
    } finally { await executor.close('shutdown'); }
  });
}

for (const oneShot of [false, true]) {
  test(`${oneShot ? 'one-shot' : 'persistent'} closed profile refuses to spawn when restored filters cannot be aligned`, async () => {
    let spawned = 0;
    const f = fixture({ upgradeNativeConversationDb: (_id, _cwd, tools) => {
      assert.equal(tools.length, 0);
      return { status: 'failed', message: 'closed filters: database is locked' };
    } });
    f.executionDependencies.spawn = () => { spawned++; throw Error('must not spawn'); };
    const executor = oneShot
      ? new AgyOneShotExecutor(f.executionDependencies)
      : new AgyDriverSession(f.executionDependencies);
    try {
      await assert.rejects(executor.run({ binary: 'OFFLINE_FAKE', conversationId: 'legacy', prompt: 'closed', nativeTools: [] }), /database is locked/);
      assert.equal(spawned, 0);
    } finally { await executor.close('shutdown'); }
  });
}

test('migration warning is visible in Pi text while preserving the native answer and success status', async () => {
  const f = fixture({
    latestUserPrompt: () => ({ prompt: 'fixture' }), piHistoryBootstrap: () => undefined,
    normalizeContext: value => value, getCurrentSystemPrompt: () => '',
    readAgyProcessProfile: () => ({}), resolveAgyModelEffort: () => undefined,
    resolveBridgeResultsFromContext: () => 0, calculateCost() {},
    createAssistantMessageEventStream: memoryStream,
    createAntigravityRuntime: () => { throw new Error('Unexpected real runtime'); },
  });
  const controller = new AgyTurnController('fixture');
  controller.push({ type: 'text', delta: 'Before ' });
  controller.push({ type: 'native_migration_warning', message: 'database is locked' });
  controller.push({ type: 'text', delta: 'after' });
  controller.push({ type: 'result', status: 'OK', response: 'Before after' });
  controller.close();
  const stream = streamAntigravity({ ...f.providerOptions,
    runtime: { beginStreamTurn: () => controller, finishTurn() {}, steerActiveTurn() {}, snapshot: () => ({}) },
    replay: {}, bridge: { refreshTools() {}, serverName: 'fixture' }, isActiveTool: () => false,
  })({ id: 'fixture', api: 'fixture', provider: 'antigravity' }, { messages: [] }, {});
  await stream.ended;
  const terminal = stream.events.at(-1);
  assert.equal(terminal.type, 'done');
  assert.equal(terminal.message.stopReason, 'stop');
  const text = terminal.message.content.filter(block => block.type === 'text').map(block => block.text);
  assert.equal(text.filter(value => !value.includes('[AGY 会话升级警告]')).join(''), 'Before after');
  assert.equal(text.filter(value => value.includes('[AGY 会话升级警告]')).length, 1);
  assert.ok(stream.events.some(event => event.type === 'text_delta' && event.delta.includes('database is locked')));
  assert.equal(terminal.message.content.filter(block => block.type === 'toolCall').length, 0);
});
