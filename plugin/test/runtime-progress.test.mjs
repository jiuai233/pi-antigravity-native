import assert from 'node:assert/strict';
import test from 'node:test';
import { createAntigravityRuntime } from '../src/runtime/runtime.ts';
import { AgyDriverSession, AgyOneShotExecutor } from '../src/driver/agy-driver.ts';

import { fixture, flush } from './offline-fixture.mjs';

function setup(oneShot) {
  const f = fixture();
  f.env.AGY_STALL_RETRY_BACKOFF_MS = '0';
  const requests = [], children = [], diagnostics = [];
  // Real ChildProcess close is asynchronous; don't turn watchdog kills into
  // synchronous fake "exited before result" errors in the one-shot path.
  f.childrenHost.spawnSync = (_cmd, args) => {
    const pid = Number(args.at(-1)); f.kills.push(pid);
    const child = children.find(value => value.pid === pid);
    if (child) queueMicrotask(() => { child.exitCode = 1; child.emit('close', 1, null); });
  };
  const driver = oneShot
    ? new AgyOneShotExecutor(f.executionDependencies)
    : new AgyDriverSession(f.executionDependencies);
  const executor = { run(request) {
    requests.push(request);
    return driver.run({...request, binary: 'OFFLINE_FAKE', spawnOverride() {
      const child = f.child(940000 + children.length); children.push(child); return child;
    }});
  }, snapshot: () => driver.snapshot(), close: (...args) => driver.close(...args) };
  const rt = createAntigravityRuntime(executor, event => diagnostics.push(event), f.childrenHost);
  const service = rt;
  return {f, rt, service, requests, children, diagnostics,
    async close() { await service.close(); }};
}

const complete = child => child.send({event: 'result', result: {status: 'SUCCESS', response: 'report complete'}});

// Protect the native waiting contract, not just the absence of one timer.
test('explicit zero waits survive long model/tool silence without restart', async () => {
  for (const oneShot of [false, true]) for (const explicitZero of [true]) {
    const r = setup(oneShot);
    if (explicitZero) {
      r.f.env.AGY_TURN_TIMEOUT_MS = '0';
      r.f.env.AGY_STALL_TIMEOUT_MS = '0';
    }
    try {
      const controller = await r.service.beginStreamTurn({prompt: 'wait natively', modelId: 'fixture'});
      await flush();
      await r.f.tick(1_200_001); // No response bytes for twenty minutes.
      assert.equal(controller.isClosed(), false);
      assert.deepEqual(r.f.kills, []);
      r.children[0].send({event: 'step_update', step_update: {step_type: 'tool', state: 'ACTIVE',
        step_index: 1, tool_name: 'generate_image'}});
      assert.equal((await controller.next()).type, 'tool_start');
      await r.f.tick(1_200_001); // Native tools also keep their own lifetime.
      assert.equal(controller.isClosed(), false);
      assert.deepEqual(r.f.kills, []);
      r.children[0].send({event: 'step_update', step_update: {step_type: 'tool', state: 'DONE',
        step_index: 1, tool_name: 'generate_image'}});
      assert.equal((await controller.next()).type, 'tool_done');
      complete(r.children[0]); await flush();
      assert.equal((await controller.next()).status, 'OK');
      assert.equal(r.requests.length, 1);
      assert.equal(r.requests[0].timeoutMs, 0);
      assert.equal(r.requests[0].inactivityTimeoutMs, 0);
      assert.equal(r.diagnostics.some(event => ['stall', 'retry'].includes(event.phase)), false);
    } finally { await r.close(); }
  }
});

test('unlimited waiting preserves manual stop, native errors and premature process exit', async () => {
  for (const oneShot of [false, true]) for (const ending of ['cancel', 'native-error', 'exit']) {
    const r = setup(oneShot);
    r.f.env.AGY_STALL_TIMEOUT_MS = '0';
    try {
      const controller = await r.service.beginStreamTurn({prompt: 'wait natively', modelId: 'fixture'});
      await flush();
      await r.f.tick(1_200_001);
      if (ending === 'cancel') {
        await r.service.abortTurn();
        assert.equal(await controller.next(), null);
        assert.equal(controller.isClosed(), true);
        assert.equal(r.f.kills.length, 1);
      } else if (ending === 'native-error') {
        r.children[0].send({event: 'result', result: {status: 'ERROR', error: 'native request failed'}});
        await flush();
        const result = await controller.next();
        assert.equal(result.status, 'ERROR');
        assert.equal(result.error, 'native request failed');
      } else {
        r.children[0].exitCode = 9;
        r.children[0].emit('close', 9, null);
        await assert.rejects(controller.next(), /exited.*9/);
      }
      assert.equal(r.requests.length, 1); // Errors are not silently resubmitted.
      assert.equal(r.diagnostics.some(event => event.phase === 'retry'), false);
    } finally { await r.close(); }
  }
});

test('direct persistent and one-shot executors support explicitly unlimited silence', async () => {
  for (const oneShot of [false, true]) for (const timeoutMs of [undefined, 0]) {
    const f = fixture();
    const child = f.child(950000);
    const driver = oneShot
      ? new AgyOneShotExecutor(f.executionDependencies)
      : new AgyDriverSession(f.executionDependencies);
    try {
      const pending = driver.run({prompt: 'direct caller', binary: 'OFFLINE_FAKE', timeoutMs, inactivityTimeoutMs: 0,
        spawnOverride: () => child});
      await flush();
      await f.tick(1_200_001);
      assert.deepEqual(f.kills, []);
      complete(child);
      assert.equal((await pending).status, 'OK');
    } finally { await driver.close('shutdown'); }
  }
});

test('explicit Pi/native tool budgets renew on results, not stream bytes', async () => {
  for (const oneShot of [false, true]) for (const source of ['pi', 'native']) {
    const r = setup(oneShot);
    r.f.env.AGY_TURN_TIMEOUT_MS = '600000';
    r.f.env.AGY_STALL_TIMEOUT_MS = '120000';
    r.f.env.AGY_TOOL_STALL_TIMEOUT_MS = '300000';
    try {
      const controller = await r.service.beginStreamTurn({prompt: 'long task', modelId: 'fixture'});
      await flush();
      for (let step = 0; step < 3; step++) {
        for (let n = 0; n < 4; n++) { await r.f.tick(100000); r.children[0].stderr.write('heartbeat\n'); }
        if (source === 'pi') {
          r.service.pushBridgeCall({id: `call-${step}`, tool: 'write', args: {}});
          assert.equal((await controller.next()).type, 'bridge_call');
          await r.f.tick(400000); // A real Pi wait consumes neither model nor stall budget.
          r.service.finishBridgeCall(`call-${step}`);
        } else {
          r.children[0].send({event: 'step_update', step_update: {step_type: 'tool', state: 'DONE',
            step_index: step, tool_name: 'generate_image'}});
          assert.equal((await controller.next()).type, 'tool_done');
        }
      }
      // No more completed tools: even continuous bytes cannot extend this step forever.
      for (let n = 0; n < 6; n++) { await r.f.tick(100000); r.children[0].stderr.write('heartbeat\n'); }
      await assert.rejects(controller.next(), /timed out after 600s/);
      assert.equal(r.requests.length, 1);
      assert.equal(r.diagnostics.at(-1).status, 'ERROR');
      assert.equal(r.diagnostics.at(-1).atMs - r.diagnostics.at(-1).lastToolCompletedAtMs, 600000);
    } finally { await r.close(); }
  }
});

test('explicit stall recovery continues the known conversation within its configured limits', async () => {
  for (const oneShot of [false, true]) for (const succeeds of [true, false]) {
    const r = setup(oneShot);
    r.f.env.AGY_TURN_TIMEOUT_MS = '600000';
    r.f.env.AGY_STALL_TIMEOUT_MS = '120000';
    r.f.env.AGY_TOOL_STALL_TIMEOUT_MS = '300000';
    try {
      const controller = await r.service.beginStreamTurn({prompt: 'ORIGINAL_IMAGE_TASK', modelId: 'fixture'});
      await flush();
      r.children[0].send({event: 'init', conversation_id: 'saved-native', init: {}});
      r.children[0].send({event: 'step_update', step_update: {step_type: 'tool', state: 'DONE',
        step_index: 1, tool_name: 'generate_image'}});
      assert.equal((await controller.next()).type, 'tool_done');
      await r.f.tick(120001);
      assert.equal(r.requests.length, 2, `oneShot=${oneShot}, succeeds=${succeeds}`);
      assert.equal(r.requests[0].inactivityTimeoutMs, 120000);
      assert.equal(r.requests[1].inactivityTimeoutMs, 300000);
      assert.equal(r.requests[1].conversationId, 'saved-native');
      assert.match(r.requests[1].prompt, /do not repeat them/);
      assert.ok(!r.requests[1].prompt.includes('ORIGINAL_IMAGE_TASK'));
      assert.equal((await controller.next()).type, 'stall');
      if (succeeds) {
        await r.f.tick(299000);
        r.children[1].stderr.write('native response resumed\n');
        complete(r.children[1]); await flush();
        assert.equal((await controller.next()).status, 'OK');
        assert.equal(r.requests.length, 2);
        assert.equal(r.diagnostics.at(-1).status, 'OK');
        assert.ok(r.diagnostics.at(-1).elapsedMs >= 299000);
      } else {
        await r.f.tick(480000);
        assert.equal((await controller.next()).type, 'stall');
        await assert.rejects(controller.next(), /timed out|stream stalled/);
        assert.equal(r.requests.length, 3); // Still at most two continuations.
        assert.equal(r.diagnostics.at(-1).status, 'ERROR');
      }
      const stalls = r.diagnostics.filter(event => event.phase === 'stall');
      assert.equal(stalls[0].waitLimitMs, 120000);
      assert.equal(stalls[0].elapsedMs, 120000);
      assert.equal(stalls[0].lastToolCompletedAtMs, 1000);
      assert.equal(stalls[0].watchdogStartedAtMs, 1000);
      assert.equal(stalls[0].lastStdoutAtMs, 1000);
      assert.ok(r.diagnostics.some(event => event.phase === 'retry' && event.attempt === 2));
      assert.equal(r.diagnostics.filter(event => event.phase === 'attempt_start')[1].waitLimitMs, 300000);
    } finally { await r.close(); }
  }
});

test('reported Pi/native tool results keep long tasks alive across slow steps', async () => {
  for (const oneShot of [false, true]) for (const source of ['pi', 'native']) {
    const r = setup(oneShot);
    try {
      const controller = await r.service.beginStreamTurn({prompt: 'long task', modelId: 'fixture'});
      await flush();
      for (let step = 0; step < 3; step++) {
        for (let n = 0; n < 4; n++) { await r.f.tick(100000); r.children[0].stderr.write('heartbeat\n'); }
        if (source === 'pi') {
          r.service.pushBridgeCall({id: `call-${step}`, tool: 'write', args: {}});
          assert.equal((await controller.next()).type, 'bridge_call');
          await r.f.tick(400000); // A real Pi wait consumes neither model nor stall budget.
          r.service.finishBridgeCall(`call-${step}`);
        } else {
          r.children[0].send({event: 'step_update', step_update: {step_type: 'tool', state: 'DONE',
            step_index: step, tool_name: 'generate_image'}});
          assert.equal((await controller.next()).type, 'tool_done');
        }
      }
      for (let n = 0; n < 12; n++) { await r.f.tick(100000); r.children[0].stderr.write('heartbeat\n'); }
      complete(r.children[0]); await flush();
      assert.equal((await controller.next()).status, 'OK');
      assert.equal(r.requests.length, 1);
      assert.equal(r.diagnostics.at(-1).status, 'OK');
      assert.deepEqual(r.f.kills, []);
    } finally { await r.close(); }
  }
});

test('known-conversation recovery waits 600s, continues without replay, and exhausts only two retries', async () => {
  for (const oneShot of [false, true]) for (const succeeds of [true, false]) {
    const r = setup(oneShot);
    try {
      const controller = await r.service.beginStreamTurn({prompt: 'ORIGINAL_IMAGE_TASK', modelId: 'fixture'});
      await flush();
      r.children[0].send({event: 'init', conversation_id: 'saved-native', init: {}});
      r.children[0].send({event: 'step_update', step_update: {step_type: 'tool', state: 'DONE',
        step_index: 1, tool_name: 'generate_image'}});
      assert.equal((await controller.next()).type, 'tool_done');
      await r.f.tick(299999);
      assert.equal(r.requests.length, 1);
      assert.deepEqual(r.f.kills, []);
      await r.f.tick(2);
      assert.equal(r.requests.length, 2, `oneShot=${oneShot}, succeeds=${succeeds}`);
      assert.equal(r.requests[0].inactivityTimeoutMs, 300000);
      assert.equal(r.requests[1].inactivityTimeoutMs, 600000);
      assert.equal(r.requests[1].conversationId, 'saved-native');
      assert.match(r.requests[1].prompt, /do not repeat them/);
      assert.ok(!r.requests[1].prompt.includes('ORIGINAL_IMAGE_TASK'));
      assert.equal((await controller.next()).type, 'stall');
      if (succeeds) {
        await r.f.tick(599000);
        r.children[1].stderr.write('native response resumed\n');
        complete(r.children[1]); await flush();
        assert.equal((await controller.next()).status, 'OK');
        assert.equal(r.requests.length, 2);
        assert.equal(r.diagnostics.at(-1).status, 'OK');
        assert.ok(r.diagnostics.at(-1).elapsedMs >= 599000);
      } else {
        await r.f.tick(1200000);
        assert.equal((await controller.next()).type, 'stall');
        await assert.rejects(controller.next(), /stream stalled/);
        assert.equal(r.requests.length, 3); // Still at most two continuations.
        assert.equal(r.diagnostics.at(-1).status, 'ERROR');
      }
      const stalls = r.diagnostics.filter(event => event.phase === 'stall');
      assert.equal(stalls[0].waitLimitMs, 300000);
      assert.equal(stalls[0].elapsedMs, 300000);
      assert.equal(stalls[0].lastToolCompletedAtMs, 1000);
      assert.equal(stalls[0].watchdogStartedAtMs, 1000);
      assert.equal(stalls[0].lastStdoutAtMs, 1000);
      assert.ok(r.diagnostics.some(event => event.phase === 'retry' && event.attempt === 2));
      assert.equal(r.diagnostics.filter(event => event.phase === 'attempt_start')[1].waitLimitMs, 600000);
    } finally { await r.close(); }
  }
});

for (const oneShot of [false, true]) for (const source of ['text', 'stderr', 'thinking']) {
  test(`${oneShot ? 'one-shot' : 'persistent'}: ${source} progress keeps generation alive beyond ten minutes without tool results`, async () => {
    const r = setup(oneShot);
    try {
      const controller = await r.service.beginStreamTurn({prompt: 'slow generation', modelId: 'fixture'});
      await flush();
      for (let step = 0; step < 8; step++) {
        await r.f.tick(240000);
        if (source === 'text') {
          r.children[0].send({event: 'step_update', step_update: {step_type: 'agent_response',
            state: 'ACTIVE', step_index: 1, text_delta: `part ${step}`}});
        } else if (source === 'stderr') {
          r.children[0].stderr.write('native progress\n');
        } else {
          controller.acceptNativeThinking({conversationId: 'fixture', stepId: 1,
            text: 'public summary '.repeat(step + 1), status: 1});
        }
        assert.equal(controller.isClosed(), false);
        assert.equal(r.requests.length, 1);
        assert.deepEqual(r.f.kills, []);
      }
      complete(r.children[0]); await flush();
      let activity;
      do { activity = await controller.next(); } while (activity && activity.type !== 'result');
      assert.equal(activity.status, 'OK');
      assert.equal(r.diagnostics.at(-1).lastToolCompletedAtMs, undefined);
      assert.equal(r.f.timers.size, 0);
    } finally { await r.close(); }
  });
}

for (const oneShot of [false, true]) {
  test(`${oneShot ? 'one-shot' : 'persistent'}: repeated public summaries do not extend the five-minute silence limit`, async () => {
    const r = setup(oneShot);
    try {
      const controller = await r.service.beginStreamTurn({prompt: 'stalled generation', modelId: 'fixture'});
      await flush();
      const snapshot = {conversationId: 'fixture', stepId: 1, text: 'unchanged summary', status: 1};
      controller.acceptNativeThinking(snapshot);
      assert.equal((await controller.next()).type, 'native_thinking_snapshot');
      for (let n = 0; n < 2; n++) {
        await r.f.tick(100000);
        controller.acceptNativeThinking(snapshot);
      }
      await r.f.tick(99999);
      controller.acceptNativeThinking(snapshot);
      assert.deepEqual(r.f.kills, []);
      await r.f.tick(1);
      assert.equal(r.requests.length, 2);
      assert.equal(r.f.kills.length, 1);
      const stall = r.diagnostics.find(event => event.phase === 'stall');
      assert.equal(stall.elapsedMs, 300000);
      assert.equal(stall.lastNativeThinkingAtMs, 1000);
    } finally { await r.close(); }
  });

  test(`${oneShot ? 'one-shot' : 'persistent'}: a silent native tool gets ten minutes before retry`, async () => {
    const r = setup(oneShot);
    try {
      const controller = await r.service.beginStreamTurn({prompt: 'slow native tool', modelId: 'fixture'});
      await flush();
      r.children[0].send({event: 'step_update', step_update: {step_type: 'tool', state: 'ACTIVE',
        step_index: 1, tool_name: 'generate_image'}});
      assert.equal((await controller.next()).type, 'tool_start');
      await r.f.tick(599999);
      assert.deepEqual(r.f.kills, []);
      await r.f.tick(1);
      assert.equal(r.requests.length, 2);
      const stall = r.diagnostics.find(event => event.phase === 'stall');
      assert.equal(stall.elapsedMs, 600000);
      assert.equal(stall.toolActive, true);
    } finally { await r.close(); }
  });
}
