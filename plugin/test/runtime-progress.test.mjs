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

test('reported Pi/native tool results renew long-task budgets; bytes without completion do not', async () => {
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
      // No more completed tools: even continuous bytes cannot extend this step forever.
      for (let n = 0; n < 6; n++) { await r.f.tick(100000); r.children[0].stderr.write('heartbeat\n'); }
      await assert.rejects(controller.next(), /timed out after 600s/);
      assert.equal(r.requests.length, 1);
      assert.equal(r.diagnostics.at(-1).status, 'ERROR');
      assert.equal(r.diagnostics.at(-1).atMs - r.diagnostics.at(-1).lastToolCompletedAtMs, 600000);
    } finally { await r.close(); }
  }
});

test('known-conversation recovery waits 300s, continues without replay, and still stops at its limits', async () => {
  for (const oneShot of [false, true]) for (const succeeds of [true, false]) {
    const r = setup(oneShot);
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
