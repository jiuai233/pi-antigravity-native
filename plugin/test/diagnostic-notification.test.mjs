import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAntigravityRuntime } from '../src/runtime/runtime.ts';
import { AgyDriverSession } from '../src/driver/agy-driver.ts';
import { fixture, flush } from './offline-fixture.mjs';

const journalFailed = () => { throw Error('journal failed'); };
const result = child => child.send({ event: 'result', result: { status: 'SUCCESS', response: 'done' } });

test('diagnostic sink failure cannot block abort, reset or shutdown', async t => {
  t.mock.method(console, 'warn', () => {});
  const f = fixture({ clock: false });
  for (const state of ['ready', 'running']) {
    for (const [method, reason] of [['abortTurn', 'abort'], ['reset', 'recycle'], ['close', 'shutdown']]) {
      const closes = [];
      const executor = { snapshot: () => ({ mode: 'persistent', state }),
        run: async () => { throw Error('no model request expected'); },
        close: async why => { closes.push(why); } };
      const runtime = createAntigravityRuntime(executor, journalFailed, f.childrenHost);
      await assert.doesNotReject(() => runtime[method]());
      assert.deepEqual(closes, [reason]);
    }
  }
});

test('diagnostic sink failure cannot prevent configuration recycle and the next result', async t => {
  t.mock.method(console, 'warn', () => {});
  const f = fixture({ clock: false });
  const children = [f.child(940001), f.child(940002)]; let spawn = 0;
  const driver = new AgyDriverSession(f.executionDependencies);
  t.after(() => driver.close('shutdown'));
  const request = revision => ({ prompt: 'fixture', binary: 'OFFLINE_FAKE', agentRevision: revision,
    onDiagnostic: journalFailed, spawnOverride: () => children[spawn++] });
  const first = driver.run(request('one')); await flush(); result(children[0]);
  assert.equal((await first).status, 'OK');
  const second = driver.run(request('two')).catch(error => error);
  await flush(); await flush(); result(children[1]);
  assert.equal((await second).status, 'OK');
  assert.notEqual(children[0].exitCode, null);
});

test('diagnostic sink failure cannot strand background-task cleanup or its terminal result', async t => {
  t.mock.method(console, 'warn', () => {});
  const f = fixture(); const child = f.child(940003);
  const driver = new AgyDriverSession(f.executionDependencies);
  t.after(() => driver.close('shutdown'));
  const pending = driver.run({ prompt: 'fixture', binary: 'OFFLINE_FAKE',
    onDiagnostic: journalFailed, spawnOverride: () => child });
  await flush();
  child.send({ event: 'step_update', step_update: { step_index: 1, step_type: 'tool', state: 'ACTIVE', tool_name: 'run_command' } });
  assert.doesNotThrow(() => result(child));
  await f.tick(500); await f.tick(500);
  assert.equal((await pending).status, 'OK');
  assert.notEqual(child.exitCode, null);
});
