import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { AgyDriverSession } from '../src/driver/agy-driver.ts';
import { killAllAgyTrees } from '../src/driver/agy-children.ts';
import { AntigravityRuntime, createAntigravityRuntime } from '../src/runtime/runtime.ts';

// Real OS children running only this fixture, never the AGY binary.
const script = `
const lines = require('node:readline').createInterface({input:process.stdin});
process.stdout.write(JSON.stringify({event:'init',conversation_id:'fixture-'+process.pid,init:{}})+'\\n');
lines.on('line', line => {
  if (JSON.parse(line).message.content === 'complete') {
    process.stdout.write(JSON.stringify({event:'result',result:{status:'SUCCESS',response:'complete fixture'}})+'\\n');
  }
});
`;
function instance() {
  let child;
  let closed = false;
  let reportReady;
  const ready = new Promise(resolve => { reportReady = resolve; });
  const driver = new AgyDriverSession();
  const runtime = createAntigravityRuntime({
    run: request => driver.run({ ...request, binary: process.execPath,
      spawnOverride: (_binary, _args, options) => {
        child = spawn(process.execPath, ['-e', script], options);
        reportReady(once(child.stdout, 'data'));
        return child;
      } }),
    snapshot: () => driver.snapshot(), close: (...args) => driver.close(...args),
  });
  const service = runtime;
  return { runtime, service, get child() { return child; },
    async begin() {
      const controller = await service.beginStreamTurn({ prompt: 'hold', modelId: 'fixture' });
      await ready;
      return controller;
    },
    async close() {
      if (closed) return;
      closed = true;
      await service.close();
    },
  };
}

test('OS fake AGY children: closing A leaves B runnable; global death cleanup kills all remaining owners', async () => {
  const a = instance(); const b = instance(); const c = instance();
  try {
    await a.begin(); const bc = await b.begin();
    const aExited = once(a.child, 'close');
    await a.close(); await aExited;
    assert.equal(b.child.exitCode, null);
    b.child.stdin.write(`${JSON.stringify({ event: 'user', message: { content: 'complete' } })}\n`);
    assert.equal((await bc.next()).status, 'OK');
    await c.begin();
    const exits = [once(b.child, 'close'), once(c.child, 'close')];
    killAllAgyTrees();
    await Promise.all(exits);
    assert.notEqual(b.child.exitCode ?? b.child.signalCode, null);
    assert.notEqual(c.child.exitCode ?? c.child.signalCode, null);
  } finally {
    // Every spawned fixture is owned by one of these runtimes.
    await Promise.all([a.close(), b.close(), c.close()]);
  }
});
