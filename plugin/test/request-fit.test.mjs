// DEBT-0060: agy hands the model only the first 192,000 UTF-8 bytes of one
// input. An oversized current request keeps its beginning and end (where the
// actual ask usually is) and names the omitted lines.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fitNativeRequest } from '../src/input/pi-input.ts';
import { streamAntigravity } from '../src/provider/stream.ts';
import { AgyTurnController } from '../src/runtime/turn.ts';
import { fixture, memoryStream } from './offline-fixture.mjs';

const MAX_INLINE = 160_000;
const ASK = 'FINAL ASK: reply with KIWI-4417';
const bytes = text => Buffer.byteLength(text, 'utf8');
const numbered = (count, last) => `${Array.from({ length: count },
  (_, i) => `row ${String(i + 1).padStart(6, '0')}: ${'x'.repeat(40)}`).join('\n')}\n${last}`;

async function temporaryRun(run) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'agy-request-fit-'));
  try { await run(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('a request within one agy input is sent unchanged', () => {
  assert.equal(fitNativeRequest('short ask'), 'short ask');
  const exact = 'a'.repeat(MAX_INLINE);
  assert.equal(fitNativeRequest(exact), exact);
});

test('an oversized request keeps its beginning and end inline and archives the full original', () => temporaryRun(directory => {
  const prompt = numbered(5000, ASK);
  assert.ok(bytes(prompt) > 192_000);
  const fitted = fitNativeRequest(prompt, { readable: true, directory });
  assert.ok(bytes(fitted) <= MAX_INLINE);
  assert.ok(fitted.includes('row 000001:'));
  assert.ok(fitted.endsWith(ASK));
  assert.match(fitted, /view_file/);
  const file = JSON.parse(fitted.match(/Full original: (".*?")\./)[1]);
  assert.equal(readFileSync(file, 'utf8'), prompt);
  const [, from, to] = fitted.match(/lines (\d+)-(\d+)/).map(Number);
  const lines = prompt.split('\n');
  assert.ok(from > 1 && to < lines.length);
  assert.ok(fitted.includes(lines[from - 2]), 'last kept head line');
  assert.ok(!fitted.includes(lines[from - 1]), 'first omitted line');
  assert.ok(!fitted.includes(lines[to - 1]), 'last omitted line');
  assert.ok(fitted.includes(lines[to]), 'first kept tail line');
  assert.equal(fitNativeRequest(prompt, { readable: true, directory }), fitted, 'deterministic across re-entries');
}));

test('without native file reading the omitted middle is stated and no file is written', () => temporaryRun(directory => {
  const fitted = fitNativeRequest(numbered(5000, ASK), { readable: false, directory });
  assert.ok(bytes(fitted) <= MAX_INLINE);
  assert.ok(fitted.endsWith(ASK));
  assert.match(fitted, /omitted/);
  assert.doesNotMatch(fitted, /Full original|view_file/);
  assert.equal(existsSync(path.join(directory, 'requests')), false);
}));

test('cuts never split a multi-byte character', () => temporaryRun(directory => {
  const last = '最后的问题：结论是什么？';
  const fitted = fitNativeRequest(`${'需求说明：'.repeat(30_000)}${last}`, { readable: true, directory });
  assert.ok(bytes(fitted) <= MAX_INLINE);
  assert.ok(!fitted.includes('\uFFFD'));
  assert.ok(fitted.endsWith(last));
}));

async function sentRequest(text, prepared, directory) {
  const f = fixture({
    piHistoryBootstrap: () => undefined, normalizeContext: context => context,
    getCurrentSystemPrompt: () => '', getCurrentTools: () => [], resolveBridgeResultsFromContext: () => 0,
    calculateCost: () => {}, createAssistantMessageEventStream: memoryStream, readAgyProcessProfile: () => ({}),
  });
  const requests = [];
  const runtime = () => ({
    async setSession() {}, snapshot: () => ({ cwd: os.tmpdir() }), finishTurn() {}, steerActiveTurn() {}, async close() {},
    async beginStreamTurn(request) {
      requests.push(request);
      const controller = new AgyTurnController(request.prompt);
      controller.push({ type: 'result', status: 'OK', response: 'ok' });
      controller.close();
      return controller;
    },
  });
  const stream = streamAntigravity({
    ...f.providerOptions,
    dependencies: { ...f.providerOptions.dependencies,
      fitNativeRequest: (value, options) => fitNativeRequest(value, { ...options, directory }) },
    runtime: runtime(), createIsolatedRuntime: runtime,
    replay: {}, bridge: { refreshTools() {}, serverName: 'fixture' }, isActiveTool: () => false,
    prepareAgent: async () => prepared,
  })({ id: 'fixture', api: 'fixture', provider: 'antigravity' }, { messages: [{ role: 'user', content: text }] }, {});
  await stream.ended;
  assert.equal(requests.length, 1);
  return requests[0].prompt;
}

const defaultAgent = { name: 'agent', nativeTools: ['view_file', 'generate_image'], nativeContractHash: 'h' };

test('the provider sends the fitted request, with a file pointer when view_file is available', () => temporaryRun(async directory => {
  assert.equal(await sentRequest('short ask', defaultAgent, directory), 'short ask');
  const sent = await sentRequest(numbered(5000, ASK), defaultAgent, directory);
  assert.ok(bytes(sent) <= MAX_INLINE);
  assert.ok(sent.endsWith(ASK));
  assert.match(sent, /Full original: .*view_file/s);
}));

test('closed-book agents and summary requests keep the beginning and end without a file pointer', () => temporaryRun(async directory => {
  const closed = await sentRequest(numbered(5000, ASK), { ...defaultAgent, nativeTools: [] }, directory);
  assert.ok(bytes(closed) <= MAX_INLINE);
  assert.ok(closed.endsWith(ASK));
  assert.doesNotMatch(closed, /Full original|view_file/);
  const instructions = 'Summarize the conversation above. FINAL INSTRUCTION KIWI-4417';
  const summary = await sentRequest(`<conversation>\n${numbered(5000, 'end')}\n</conversation>\n\n${instructions}`,
    defaultAgent, directory);
  assert.ok(bytes(summary) <= MAX_INLINE);
  assert.ok(summary.endsWith(instructions), 'Pi puts summary instructions last');
  assert.doesNotMatch(summary, /Full original|view_file/);
}));
