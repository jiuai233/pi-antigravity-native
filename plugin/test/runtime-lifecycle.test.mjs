import assert from 'node:assert/strict';
import test from 'node:test';
import { createAntigravityRuntime } from '../src/runtime/runtime.ts';
import { AgyDriverSession, AgyOneShotExecutor } from '../src/driver/agy-driver.ts';
import { AgyTurnBudget } from '../src/runtime/turn-budget.ts';
import { getAgyChildrenRegistry, installAgyDeathHooks, trackAgyChild, killProcessTreeSync } from '../src/driver/agy-children.ts';
import { AgyPiBridge, resolveBridgeResultsFromContext } from '../src/extension/bridge.ts';

import { buildOneShotAgyArgs, buildDriverAgyArgs } from '../src/driver/agy-client.ts';
import { fixture, flush } from './offline-fixture.mjs';
import { registerSessionHooks } from '../src/extension/session-hooks.ts';
import { TaskMonitor } from '../src/extension/task-monitor.ts';

function runtime(f, pid, oneShot = false, onRequest = () => {}) {
  const child = f.child(pid);
  const driver = oneShot
    ? new AgyOneShotExecutor(f.executionDependencies)
    : new AgyDriverSession(f.executionDependencies);
  const executor = { run: request => {
    onRequest(request);
    return driver.run({ ...request, binary: 'OFFLINE_FAKE', spawnOverride: () => child });
  },
    snapshot: () => driver.snapshot(), close: (...args) => driver.close(...args) };
  const rt = createAntigravityRuntime(executor, undefined, f.childrenHost);
  return { rt, service: rt, child };
}
async function begin(r) {
  const controller = await r.service.beginStreamTurn({ prompt: 'fixture', modelId: 'gemini-fixture' });
  await flush();
  return controller;
}
async function close(r) {
  await r.service.close();
}
function result(child) {
  child.send({ event: 'result', result: { status: 'SUCCESS', response: 'complete fixture' } });
}
function bridge(f, r) {
  let handler;
  const serverFactory = fn => {
    handler = fn;
    return { once() {}, off() {}, listen(_port, _host, ready) { ready(); },
      address: () => ({ port: 12345 }), close: done => done() };
  };
  const b = new AgyPiBridge(undefined, serverFactory);
  b.setToolSource(() => [{ name: 'slow_tool', parameters: {} }]);
  b.refreshTools();
  b.setOnCall(call => r.service.pushBridgeCall(call));
  b.setOnSettled(id => r.service.finishBridgeCall(id));
  return { b, async call() {
    await b.start();
    // Exercise the actual HTTP/RPC handler without sockets or network I/O.
    const { EventEmitter } = await import('node:events');
    const req = new EventEmitter();
    req.headers = {}; req.method = 'POST';
    const response = new Promise(resolve => {
      handler(req, { writeHead() {}, end: body => resolve(JSON.parse(body)) });
    });
    req.emit('data', Buffer.from(JSON.stringify({ id: 1, method: 'tools/call',
      params: { name: 'pi__slow_tool', arguments: {} } })));
    req.emit('end');
    await flush();
    return { response };
  } };
}

test('a loaded legacy sweep cannot reap new owned/default trees; current exit hooks still reap them', () => {
  const f = fixture();
  const registry = getAgyChildrenRegistry(f.childrenHost);
  // These are the shared fields and hook marker used by the old tracker.
  registry.hooksInstalled = true;
  registry.live.add(910001);
  registry.owners = new Map([[910001, Symbol('legacy')]]);
  installAgyDeathHooks(f.childrenHost);
  trackAgyChild({ pid: 910002 }, Symbol('current-runtime'), f.childrenHost);
  trackAgyChild({ pid: 910003 }, undefined, f.childrenHost);
  // Replay the old cleanup algorithm, including its clear of the old owner map.
  for (const pid of [...registry.live]) killProcessTreeSync(pid, f.childrenHost);
  registry.live.clear(); registry.owners?.clear();
  assert.deepEqual(f.kills, [910001]);
  f.hooks.get('exit')();
  assert.deepEqual(f.kills, [910001, 910002, 910003]);
  assert.equal(registry.ownedTrees.size, 0);
});

test('actual A session_shutdown kills only A; B completes; process exit sweeps all remaining owners', async () => {
  const f = fixture();
  installAgyDeathHooks(f.childrenHost);
  const a = runtime(f, 900001); const b = runtime(f, 900002);
  try {
    await begin(a); const bc = await begin(b);
    const monitor = new TaskMonitor(a.rt, {
      listTasks: async () => [], listArtifacts: async () => [], stopTask: async () => 0 });
    monitor.sessionCwd = 'fixture';
    const handlers = {};
    registerSessionHooks({ pi: { on: (event, fn) => { handlers[event] = fn; } }, runtime: a.rt,
      sync: {}, monitor, bridge: { teardown: async () => {} }, refreshStaleModels: async () => {} });
    await handlers.session_shutdown();
    assert.deepEqual(f.kills, [900001]);
    assert.equal(b.child.exitCode, null);
    result(b.child); await flush();
    assert.equal((await bc.next()).status, 'OK');
    assert.equal(b.child.exitCode, null);
    // A completed persistent process and a lingering one-shot tree remain
    // process-owned and must both be reaped by the process-level exit hook.
    const c = runtime(f, 900003, true);
    try {
      await begin(c); result(c.child); await flush();
      f.hooks.get('exit')();
      assert.deepEqual(f.kills, [900001, 900002, 900003]);
      assert.equal(getAgyChildrenRegistry(f.childrenHost).live.size, 0);
    } finally { await close(c); }
  } finally { await close(b); }
});

test('one-shot logical completion retains tree ownership until its own runtime closes', async () => {
  const f = fixture();
  const a = runtime(f, 900011, true); const b = runtime(f, 900012, true);
  try {
    await begin(a); const bc = await begin(b);
    result(a.child); await flush();
    await close(a);
    assert.deepEqual(f.kills, [900011]);
    result(b.child); await flush();
    assert.equal((await bc.next()).status, 'OK');
  } finally { await close(b); }
});

for (const oneShot of [false, true]) {
  test(`${oneShot ? 'one-shot' : 'persistent'}: two slow Pi waits exceed 600s wall time without consuming run/stall budgets`, async () => {
    const f = fixture();
    const r = runtime(f, oneShot ? 900022 : 900021, oneShot);
    const { b, call } = bridge(f, r);
    try {
      const controller = await begin(r);
      await f.tick(100_000);
      for (let i = 0; i < 2; i++) {
        r.child.send({ event: 'step_update', step_update: { step_type: 'tool', state: 'ACTIVE',
          step_index: i, tool_name: 'call_mcp_tool', tool_info: { parameters: { ServerName: b.serverName } } } });
        assert.equal((await controller.next()).type, 'tool_start');
        const pending = await call();
        const activity = await controller.next();
        assert.equal(activity.type, 'bridge_call');
        await f.tick(400_000); // Below the unchanged 480s cap, above either stall cap.
        assert.equal(r.child.exitCode, null);
        assert.equal(controller.isClosed(), false);
        resolveBridgeResultsFromContext(b, [{ role: 'toolResult', toolCallId: activity.id,
          content: [{ type: 'text', text: 'slow tool completed' }] }]);
        assert.equal((await pending.response).result.isError, false);
        r.child.send({ event: 'step_update', step_update: { step_type: 'tool', state: 'DONE',
          step_index: i, tool_name: 'call_mcp_tool' } });
        assert.equal((await controller.next()).type, 'tool_done');
      }
      result(r.child); await flush();
      assert.equal((await controller.next()).status, 'OK');
      assert.deepEqual(f.kills, []);
    } finally { await close(r); await b.close(); }
  });
}

test('an explicit 600s budget still expires with live stream traffic after a Pi wait', async () => {
  const f = fixture();
  f.env.AGY_TURN_TIMEOUT_MS = '600000';
  const r = runtime(f, 900031); const { b, call } = bridge(f, r);
  try {
    const controller = await begin(r);
    const pending = await call();
    const activity = await controller.next();
    await f.tick(400_000);
    b.resolveCall(activity.id, { content: 'done', isError: false });
    await pending.response;
    for (let i = 0; i < 5; i++) {
      await f.tick(100_000); r.child.stderr.write('fixture heartbeat\n');
    }
    await f.tick(100_000);
    await assert.rejects(controller.next(), /logical turn timed out after 600s/);
    assert.equal(f.kills.length, 1);
  } finally { await close(r); await b.close(); }
});

test('bridge cap remains 480s and resumes run budget; cancellation still kills during a Pi wait', async () => {
  const f = fixture();
  const r = runtime(f, 900041); const { b, call } = bridge(f, r);
  try {
    const controller = await begin(r);
    const pending = await call(); await controller.next();
    await f.tick(480_000);
    assert.match((await pending.response).result.content[0].text, /480s/);
    assert.equal(b.pendingCount, 0);
    const again = await call(); await controller.next();
    await r.service.abortTurn();
    b.cancelPending('fixture cancellation');
    assert.equal((await again.response).result.isError, true);
    assert.equal(r.child.exitCode, 1);
  } finally { await close(r); await b.close(); }
});

test('overlapping Pi calls resume the remaining run budget only after the last result', async () => {
  const f = fixture(); let expired = false;
  const budget = new AgyTurnBudget(600_000, () => { expired = true; });
  try {
    await f.tick(100_000);
    budget.pause('first'); budget.pause('second');
    await f.tick(400_000); budget.resume('first');
    await f.tick(400_000);
    assert.equal(budget.paused, true);
    assert.equal(budget.remainingMs(), 500_000);
    budget.resume('second');
    await f.tick(499_999); assert.equal(expired, false);
    await f.tick(1); assert.equal(expired, true);
  } finally { budget.dispose(); }
});

test('one-shot waits natively by default; only explicit direct limits add a CLI wall cap', () => {
  for (const timeoutMs of [undefined, 0]) {
    assert.equal(buildOneShotAgyArgs({ prompt: 'fixture', timeoutMs }).includes('--print-timeout'), false);
  }
  const direct = buildOneShotAgyArgs({ prompt: 'fixture', timeoutMs: 600000 });
  assert.ok(direct.includes('--print-timeout')); assert.ok(direct.includes('600s'));
  const managed = buildOneShotAgyArgs({ prompt: 'fixture', budget: {} });
  assert.equal(managed.includes('--print-timeout'), false);
});

test('both CLI modes discover private MCP configuration without replacing the project directory', () => {
  for (const builder of [buildOneShotAgyArgs, buildDriverAgyArgs]) {
    const args = builder({ prompt: 'fixture', cwd: 'project', mcpDirectory: 'private-bridge' });
    assert.deepEqual(Array.from(args).filter((_arg, i) => args[i - 1] === '--add-dir'),
      ['project', 'private-bridge']);
  }
});

test('runtime passes private discovery to the driver and only a changed directory recycles it', async () => {
  const f = fixture();
  const spawned = [];
  const driver = new AgyDriverSession(f.executionDependencies);
  const executor = { run: request => driver.run({ ...request, binary: 'OFFLINE_FAKE',
    spawnOverride: (_binary, args, options) => {
      const child = f.child(900060 + spawned.length);
      spawned.push({ child, args, options });
      return child;
    } }), snapshot: () => driver.snapshot(), close: (...args) => driver.close(...args) };
  const rt = createAntigravityRuntime(executor, undefined, f.childrenHost);
  const service = rt;
  try {
    await service.setSession('fixture-project', 'gemini-fixture');
    for (const mcpDirectory of ['private-a', 'private-a', 'private-b']) {
      const controller = await service.beginStreamTurn({ prompt: 'fixture',
        modelId: 'gemini-fixture', mcpDirectory });
      await flush();
      const current = spawned.at(-1);
      assert.equal(current.options.cwd, 'fixture-project');
      assert.ok(current.args.includes(mcpDirectory));
      assert.equal(driver.snapshot().config.mcpDirectory, mcpDirectory);
      result(current.child);
      assert.equal((await controller.next()).status, 'OK');
      await flush();
      await service.finishTurn();
    }
    assert.equal(spawned.length, 2);
    assert.equal(driver.snapshot().stats.lastRecycleReason, 'mcp-directory');
    assert.equal(spawned[0].child.exitCode, 0);
    assert.equal(spawned[1].child.exitCode, null);
  } finally {
    await service.close();
  }
});

test('restored native contexts receive the current bridge once without resetting history or tool-loop identity', async () => {
  const f = fixture();
  const requests = [];
  const r = runtime(f, 900070, false, request => requests.push(request));
  const bridgeBootstrap = '<pi_tool_bridge>current server and schema path</pi_tool_bridge>';
  try {
    await r.service.restoreConversation({ conversationId: 'native-saved',
      cwd: 'fixture-project', modelId: 'gemini-fixture', turns: 4, usage: {}, systemPromptHash: 'same-system' });
    for (let i = 0; i < 2; i++) {
      const request = { prompt: `user ${i}`, modelId: 'gemini-fixture',
        systemPromptHash: 'same-system', bridgeBootstrap, mcpDirectory: 'private-new-instance' };
      const controller = await r.service.beginStreamTurn(request);
      await flush();
      assert.equal(controller.prompt, request.prompt);
      assert.equal(requests[i].conversationId, 'native-saved');
      assert.equal(requests[i].prompt, i === 0 ? `${bridgeBootstrap}\n\n${request.prompt}` : request.prompt);
      const reentry = await r.service.beginStreamTurn(request);
      assert.equal(reentry, controller);
      assert.equal(requests.length, i + 1);
      result(r.child);
      assert.equal((await controller.next()).status, 'OK');
      await flush(); await r.service.finishTurn();
    }
  } finally { await close(r); }
});

for (const oneShot of [false, true]) {
  test(`${oneShot ? 'one-shot' : 'persistent'} effort stays high on re-entry and turns medium only on a fresh controller`, async () => {
    const f = fixture();
    const spawned = [];
    const driver = oneShot
      ? new AgyOneShotExecutor(f.executionDependencies)
      : new AgyDriverSession(f.executionDependencies);
    const executor = {
      run: request => driver.run({ ...request, binary: 'OFFLINE_FAKE',
        spawnOverride: (_binary, args) => {
          const child = f.child(900080 + spawned.length);
          spawned.push({ child, args });
          return child;
        } }),
      snapshot: () => driver.snapshot(), close: (...args) => driver.close(...args),
    };
    const rt = createAntigravityRuntime(executor, undefined, f.childrenHost);
    const service = rt;
    const begin = effort => service.beginStreamTurn({
      prompt: 'fixture', modelId: 'gemini-fixture', effort,
    });
    try {
      const high = await begin('high');
      await flush();
      assert.equal(high.effectiveEffort, 'high');
      assert.equal((await begin('medium')), high);
      if (!oneShot) assert.equal(driver.snapshot().config.effort, 'high');
      assert.equal(spawned.length, 1);
      assert.ok(spawned[0].args.includes('high'));
      result(spawned[0].child);
      await flush();
      // Finished but unconsumed native events also belong to the original effort.
      assert.equal(await begin('medium'), high);
      assert.equal((await high.next()).status, 'OK');
      await service.finishTurn();

      const medium = await begin('medium');
      await flush();
      assert.notEqual(medium, high);
      assert.equal(medium.effectiveEffort, 'medium');
      if (!oneShot) assert.equal(driver.snapshot().config.effort, 'medium');
      assert.equal(spawned.length, 2);
      assert.ok(spawned[1].args.includes('medium'));
      result(spawned[1].child);
      assert.equal((await medium.next()).status, 'OK');
    } finally {
      await service.close();
    }
  });
}

test('explicitly enabled stall detection exhausts only the existing two retries', async () => {
  const f = fixture(); f.env.AGY_STALL_RETRY_BACKOFF_MS = '0';
  f.env.AGY_STALL_TIMEOUT_MS = '120000';
  const r = runtime(f, 900051);
  try {
    const controller = await begin(r);
    await f.tick(360_001);
    const first = await controller.next(); const second = await controller.next();
    assert.equal(first.type, 'stall'); assert.equal(first.retry, 1);
    assert.equal(second.type, 'stall'); assert.equal(second.retry, 2);
    await assert.rejects(controller.next(), /stream stalled/);
    assert.equal(f.kills.length, 3);
  } finally { await close(r); }
});


test('live stream traffic after a Pi wait keeps the turn alive beyond 600s', async () => {
  const f = fixture();
  const r = runtime(f, 900031); const { b, call } = bridge(f, r);
  try {
    const controller = await begin(r);
    const pending = await call();
    const activity = await controller.next();
    await f.tick(400_000);
    b.resolveCall(activity.id, { content: 'done', isError: false });
    await pending.response;
    for (let i = 0; i < 12; i++) {
      await f.tick(100_000); r.child.stderr.write('fixture heartbeat\n');
    }
    assert.equal(controller.isClosed(), false);
    result(r.child); await flush();
    assert.equal((await controller.next()).status, 'OK');
    assert.deepEqual(f.kills, []);
  } finally { await close(r); await b.close(); }
});


test('overlapping Pi calls keep silence watchdogs paused until the last result', async () => {
  const f = fixture();
  const budget = new AgyTurnBudget(0, () => {});
  const states = [];
  budget.subscribe(() => states.push(budget.paused));
  try {
    budget.pause('first'); budget.pause('second');
    await f.tick(400_000); budget.resume('first', true);
    await f.tick(400_000);
    assert.equal(budget.paused, true);
    assert.equal(states.every(Boolean), true);
    budget.resume('second', true);
    assert.equal(budget.paused, false);
    assert.equal(states.at(-1), false);
    assert.equal(budget.lastToolCompletedAtMs, Date.now());
    assert.equal(f.timers.size, 0);
  } finally { budget.dispose(); }
});


test('ordinary AGY silence still stalls and exhausts only the existing two retries', async () => {
  const f = fixture(); f.env.AGY_STALL_RETRY_BACKOFF_MS = '0';
  const r = runtime(f, 900051);
  try {
    const controller = await begin(r);
    await f.tick(900_001);
    const first = await controller.next(); const second = await controller.next();
    assert.equal(first.type, 'stall'); assert.equal(first.retry, 1);
    assert.equal(second.type, 'stall'); assert.equal(second.retry, 2);
    await assert.rejects(controller.next(), /stream stalled/);
    assert.equal(f.kills.length, 3);
  } finally { await close(r); }
});
