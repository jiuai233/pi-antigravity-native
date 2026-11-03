
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAntigravityRuntime } from '../src/runtime/runtime.ts';
import { fixture, flush } from './offline-fixture.mjs';

// The driver hands the terminal result to Pi before run() resolves (e.g. while
// reaping a background task). These runs deliver the result, then wait.
function deferredRuntime(f, { pushResult = true } = {}) {
  const runs = [];
  const executor = {
    run: request => new Promise(resolve => {
      request.onConversation?.('native-1');
      if (pushResult) request.onActivity?.({ type: 'result', status: 'OK', response: 'done', error: undefined, usage: undefined });
      runs.push({ request, finish: () => resolve({ conversationId: 'native-1', status: 'OK', response: 'done',
        error: undefined, usage: { input_tokens: 100 }, activities: [], finished: true }) });
    }),
    snapshot: () => ({ mode: 'one-shot', state: 'idle', lifecycle: [] }),
    close: async () => {},
  };
  const rt = createAntigravityRuntime(executor, undefined, f.childrenHost);
  return { rt, service: rt, runs };
}
const begin = (r, prompt) => r.service.beginStreamTurn({ prompt, modelId: 'gemini-fixture' });
async function close(r) {
  await r.service.close();
}

test('a new prompt waits for the delivered turn to commit before starting', async () => {
  const f = fixture();
  const r = deferredRuntime(f);
  try {
    const first = await begin(r, 'first');
    await flush();
    assert.equal((await first.next()).type, 'result');
    await r.service.finishTurn();

    let started = false;
    const second = begin(r, 'second').then(controller => { started = true; return controller; });
    await flush();
    assert.equal(started, false);
    assert.equal(r.runs.length, 1);

    r.runs[0].finish();
    await second;
    await flush();
    assert.equal(r.runs.length, 2);
    assert.equal(r.runs[1].request.conversationId, 'native-1');
    const snapshot = await r.service.snapshot();
    assert.equal(snapshot.turns, 1);
    assert.equal(snapshot.conversationUsage.input_tokens, 100);
  } finally { await close(r); }
});

test('a stuck commit holds the next prompt only for the bounded wait, and never re-attaches', async () => {
  const f = fixture();
  const r = deferredRuntime(f);
  try {
    const first = await begin(r, 'same');
    await flush();
    assert.equal((await first.next()).type, 'result');
    await r.service.finishTurn();

    const second = begin(r, 'same');
    await flush();
    assert.equal(r.runs.length, 1);
    await f.tick(5_000);
    const controller = await second;
    await flush();
    assert.notEqual(controller, first);
    assert.equal(r.runs.length, 2);
  } finally { await close(r); }
});

test('a turn whose result was never delivered is still replaced immediately', async () => {
  const f = fixture();
  const r = deferredRuntime(f, { pushResult: false });
  try {
    await begin(r, 'running');
    await flush();
    await r.service.finishTurn();
    await begin(r, 'steer');
    await flush();
    assert.equal(r.runs.length, 2);
  } finally { await close(r); }
});
